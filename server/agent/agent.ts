// Agent 主循环:接收用户指令 -> 流式调用 LLM -> 执行工具 -> 迭代直到完成。
// 架构:
// - 事件溯源:会话是 append-only 的 SessionEvent 日志(见 session.js),LLM 消息
//   历史由 deriveMessages() 投影得出,不再单独维护 history 数组——"模型可见即可回放"。
// - Turn/Step 生命周期:一步(step)= 一次模型请求 + 它发起的工具调用;一轮(turn)=
//   若干步。每次边界都写入事件日志,turn/end 记录结束原因(completed/aborted/error/max-iters)。
// - 工具走注册表执行管线(见 registry.js):单个工具失败是结构化错误结果,绝不终结整轮。
// - Inbox 输入路由(对齐 harness 的 next-turn / next-step 两个收件边界):
//   空闲时 submit() 开新轮;运行中注入下一步,作为 user 消息进入模型上下文,
//   让用户能在 Agent 工作期间补充/纠正指令。
// - 多会话并行:每个会话一个运行时(事件日志 + inbox/steer/signal/busy,见 newRuntime),
//   各会话独立驱动互不阻塞;所有发给前端的事件都带 sid,前端按会话路由显示。
import { AGENT, NO_WORKSPACE } from '../config.ts';
import fsp from 'node:fs/promises';
import { LlmClient, isContextOverflowError } from './llm.ts';
import { lastGeneratedImage, imageCaption, runImageJob } from './image-gen.ts';
import { compactHistory, summarizeWithLlm, selectCompactRange, resolveCharBudget, estimateTokens, measureMessages, pruneToolResults } from './compact.ts';
import { Session, foldTodos, trimMessagesByBudget, type SessionEvent } from './session.ts';
import { ToolRegistry, type ToolResult } from './registry.ts';
import { DEFAULT_PERMISSION_MODE, foldPermissionMode, isPermissionMode, type PermissionMode } from './permission.ts';
import { PERMISSION_MODE_META } from './permission.ts';
import { registerTools, getEnvInfo, getLocalEnvInfo, refreshSkillsCatalog, skillsCatalogStale, getSkillsCatalog, renderSkillCatalog, getSkillFull } from './tools.ts';
import { localFs, runWithLocalWorkspaceBinding } from '../core/local-fs.ts';
import { renderPromptInjectSection } from './prompt-inject.ts';
import { sshManager as ssh, runWithWorkspaceBinding } from '../core/ssh-manager.ts';
import * as sessions from '../store/session-store.ts';
import { getDefaultPermissionMode as storeDefaultMode, setDefaultPermissionMode as storeSetDefaultMode } from '../store/settings-store.ts';
import { getAttachment, readImageDataURL, readImageBytes, saveAttachment, isTextLike, attachmentPath, type AttachmentMeta } from '../store/attachments-store.ts';

// 全局唯一工具注册表:启动时注册全部内置工具与守卫
const registry = new ToolRegistry();
registerTools(registry);
// 供 ws 层列出/开关工具插件(设置 → 工具插件)
export { registry as toolRegistry };

// ---- 自动续推
// 完成判定对齐 harness agent-loop:模型返回 0 个 tool_calls 即本轮结束(completed),
// 不再注入 goal_round 续推消息。任务计划(todo)只作为前端进度面板展示,
// 由系统提示词的规则约束模型"清空计划前不得停止",而不是由宿主强行续跑。

// ---- repeat-tool-reminder(移植自 harness guard/repeat-tool-reminder)----
// 连续相同工具+参数调用达到阈值时在下一步注入提醒(advisory,不拦截调用),防模型原地打转。
// 参数规范化:深排序后 JSON.stringify,仅属性顺序不同的参数视为同一调用。
function sortJsonValue(v) {
  if (Array.isArray(v)) return v.map(sortJsonValue);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortJsonValue(v[k]);
    return o;
  }
  return v;
}
function canonicalizeArgs(rawArgs) {
  try { return JSON.stringify(sortJsonValue(JSON.parse(rawArgs))); } catch { return String(rawArgs || ''); }
}
function previewArgs(rawArgs, cap) {
  const s = String(rawArgs || '');
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `…(+${s.length - cap} 字符)`;
}

// 判断错误是否为"模型/上游明确不支持工具调用"(如推理模型 deepseek-reasoner 等)。
// 认定标准:错误文案必须明确出现"工具/tool calling/function calling"字样并声明其不被支持。
// 不能只匹配 "not supported" 这类泛化措辞——中转网关的临时故障(渠道切换、限流等)
// 文案里也常含 "not supported",误判成能力缺失会把整个会话静默降级、掩盖真实错误。
const TOOL_UNSUPPORTED_RES = [
  /MODEL_TOOL_NOT_SUPPORTED/i,                                                            // DeepSeek 官方错误码
  /tools?\s+(?:is\s+|are\s+)?not\s+support(?:ed)?/i,                                      // tools are not supported
  /tools?\s+unsupported/i,                                                                // tool unsupported
  /not\s+(?:be\s+)?support(?:ed)?\s+(?:any\s+)?(?:tools?|tool\s+calls?|tool\s+calling|tool\s+use|function\s+calling|function\s+calls?)/i, // does not support tools / tool calling / function calling
  /(?:tool\s+calls?|tool\s+calling|tool\s+use|function\s+calling|function\s+calls?)\s+(?:is\s+|are\s+)?not\s+support(?:ed)?/i, // tool calling is not supported
  /不支持\s*(?:工具|函数调用|function\s*calling)/i,                                        // 不支持工具调用 / 不支持 function calling
  /工具调用[^。]{0,30}不支持/                                                               // 该模型的工具调用暂不支持
];
export function isToolUnsupportedError(e) {
  const s = String(e?.message || '');
  return TOOL_UNSUPPORTED_RES.some((re) => re.test(s));
}

// ---- 聊天附件(图片/文件)----
// 前端 speak 只携带上传后的附件 id 列表,元数据一律以服务端存储为准(防伪造)。
// 事件日志只存元数据;模型可见文本在落事件时由附件说明文本合成,
// 图片字节在请求期(模型开启多模态时)才读盘转 base64 data URL 注入。

// 前端提交的附件载荷:仅认 id,其余字段以服务端索引为准
function resolveAttachments(raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentMeta[] = [];
  for (const it of raw) {
    const id = typeof it === 'string' ? it : String(it?.id || '');
    if (!id) continue;
    const meta = getAttachment(id);
    if (meta) out.push(meta);
  }
  return out;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + 'B';
}

// 小文本文件直接内联进上下文的上限(超过则只给路径让 AI 自行决定是否读取)
const INLINE_TEXT_MAX = 200 * 1024;

// 生成附件的模型可见文本块(非图片,或图片但模型不支持视觉时,这是内容的唯一载体):
// - 小文本文件:直接内联全文(围栏代码块),AI 立即可读
// - 其他文件:给出名称、大小与本机存储路径(供 run_local_command 等工具按需读取)
async function attachmentTextBlocks(atts: AttachmentMeta[]): Promise<string> {
  const blocks: string[] = [];
  for (const a of atts) {
    if (a.kind === 'image') continue; // 图片由请求期 image_url 注入承担,这里不加文本
    if (isTextLike(a.mime, a.name) && a.size <= INLINE_TEXT_MAX) {
      const p = attachmentPath(a.id);
      try {
        if (p) {
          const content = (await fsp.readFile(p, 'utf8')).slice(0, INLINE_TEXT_MAX);
          blocks.push(`【附件文件:${a.name}(${fmtSize(a.size)})】内容如下:\n\`\`\`\n${content}\n\`\`\``);
          continue;
        }
      } catch { /* 读取失败降级为路径说明 */ }
    }
    const p = attachmentPath(a.id);
    blocks.push(`【附件:文件 ${a.name}(${fmtSize(a.size)},MIME ${a.mime})】${p ? `已保存在本机 ${p}(如需读取内容可用本地命令工具)` : '(文件已丢失)'}`);
  }
  return blocks.length ? '\n\n' + blocks.join('\n\n') : '';
}

// 请求期多模态注入:把带图片附件的 user 消息升级为 OpenAI content 数组
// (文本段 + image_url 段);读图失败则静默跳过该段(文本说明仍在)。
// 返回新数组,不改写投影原消息(裁剪/压缩/测量仍基于元数据口径)。
async function materializeImageParts(messages: any[]): Promise<any[]> {
  let touched = false;
  const out = await Promise.all(messages.map(async (m) => {
    if (!m || m.role !== 'user' || !Array.isArray(m.attachments) || typeof m.content !== 'string') return m;
    const imgs = (m.attachments as AttachmentMeta[]).filter((a) => a && a.kind === 'image');
    if (!imgs.length) return m;
    const parts: any[] = [{ type: 'text', text: m.content }];
    for (const img of imgs) {
      const url = await readImageDataURL(img.id);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
    touched = true;
    return { ...m, content: parts };
  }));
  return touched ? out : messages;
}

// ---- 生图模型(imageGen)----
// 纯图像端点模型(gpt-image-2 等)在 chat/completions 上会被网关直接拒绝,且没有
// "多轮上下文"这个概念:/images/* 只接受一个 prompt 字符串。因此开启 imageGen 后
// 整轮换走 _runImageTurn:一轮 = 一次生图请求 = 一张成图,不参与工具循环与压缩。
// "多轮对话式生图"由这里在客户端侧造:每轮自动携带上一张成图作为参考图送 /images/edits,
// 用户说"再亮点""换成夜晚"即作用于上一张图(图像模型本身是指令跟随式的编辑模型)。
//
// 另一条(更常用的)路径是 generate_image 工具:对话仍用文本模型,由它读历史、抽参数、
// 决定文生图还是图生图,再调用生图端点。两条链路共用 image-gen.ts 的执行层。
// 取参考图/落盘/摘要等公共逻辑见 image-gen.ts(此处不再重复实现)。

// 会话日志中最后一条"运行时上下文"快照的内容(供运行时恢复 lastContextText,
// 避免服务重启/会话切回后对未变化的快照重复追加 user 消息)
function lastRuntimeContextText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'user/message' && ev.data?.source === 'runtime') return String(ev.data.content || '');
  }
  return null;
}

// 会话运行时:每个会话独立持有事件日志与驱动状态,多会话可并行运行互不阻塞
function newRuntime(session) {
  return {
    session,       // Session:该会话的事件日志(唯一事实源)
    busy: false,   // 该会话的 driver 是否在运行(idle/running 状态机的运行态)
    signal: null,  // 该会话当前轮的 AbortController
    inbox: [],     // next-turn 输入队列(followup,空闲时逐条开新轮)
    steer: [],     // next-step 注入队列(运行中补充指令,下一步生效)
    pending: [],   // 待执行队列(工作中提交的消息,FIFO,当前轮结束后逐条自动执行)
    queueSeq: 0,   // 待执行队列项的自增 id(供前端按 id 做立即执行/删除等操作)
    driving: null, // 进行中的 driver promise(同会话并发提交复用同一驱动)
    boundConn: null, // 当前轮绑定的 SSH 连接(切走活动连接后工具仍操作它)
    // 该会话归属的服务器键(username@host:port,取自会话元数据):新一轮开始时按它解析
    // 连接对象。缺失(旧会话/local 作用域)才回落当前活动连接。
    connKey: null as string | null,
    // 会话绑定的远程工作区:路径 | NO_WORKSPACE(「不在工作区对话」,边界=整台服务器)
    // | null(未绑定,执行时回落连接级)。经 runWithWorkspaceBinding 作用域生效。
    workspace: null as string | null,
    // 会话绑定的本地工作区:同上,NO_WORKSPACE 时边界=整台电脑(见 local-fs resolveInLocalWorkspace)
    localWorkspace: null as string | null,
    // 最近一次发给模型的"运行时上下文"快照文本(变化才发新消息,见 _buildRuntimeContext);
    // 从日志恢复,重启/切回会话后不会对未变化的快照重复注入
    lastContextText: lastRuntimeContextText(session.events),
    lastCallKey: null, // 上一次工具调用的规范化键(工具名+参数),repeat-tool-reminder 追踪用
    lastCallCount: 0,  // 连续相同调用次数
    overflowRecoveries: 0, // 本轮上下文爆窗恢复次数(达到上限后不再重试,防死循环)
    live: null as null | { content: string; reasoning: string } // 当前步已流式收到、尚未落盘的回复半成品(供 getHistory 投影,见 onDelta)
  };
}

// 兜底空日志:活跃会话运行时缺失(恢复失败)时投影为空
const EMPTY_SESSION = new Session();

// 事件日志 -> 前端消息数组投影(getHistory 的实现,与具体会话无关)。
// 与 deriveMessages 同款配对过滤:无前置 assistant tool_calls 的孤儿 tool/result
// (旧版压缩 bug 遗留 + 轮末自愈补的"中止"结果)不投影,避免前端渲染游离工具卡片。
// 显示语义(非破坏压缩):完整投影全部消息——被压缩的早期消息也原样显示,
// 只在最后一个压缩检查点的"保留区首个消息面事件之前"插入一行压缩标记
// (compaction 元数据,前端渲染为 CompactionRow,披露模型自该处起只看摘要)。
// 旧版破坏式压缩遗留(compaction/done 无 dropThroughSeq,早期消息已被物理删除)
// 则原位投影标记行,已删的消息无法回看。
export function projectEvents(events) {
  const out = [];
  const calls = new Map();
  let alive = new Set(); // 最近一条 assistant 声明的存活 tool_call id(OpenAI 配对语义)
  // 生效压缩检查点(最后一条带 dropThroughSeq 的 compaction/done);见 Session.deriveMessagesWithTrace
  let cp = null;         // { summary, dropCount, manual, dropThroughSeq }
  let cpSeq = -1;
  for (const ev of events) {
    if (ev.type === 'compaction/done' && typeof ev.data?.dropThroughSeq === 'number') {
      cp = ev.data;
      cpSeq = ev.seq;
    }
  }
  let cpPlaced = !cp;
  const placeCp = () => {
    if (!cp) return;
    out.push({
      role: 'user', content: cp.summary || '【上下文已自动压缩】早期对话已省略。', time: cpSeq >= 0 ? (events[cpSeq]?.time ?? Date.now()) : Date.now(),
      // 压缩标记元数据:前端据此渲染「压缩标记行」(dropCount=被压缩消息数,manual=手动压缩)
      compaction: { dropCount: typeof cp.dropCount === 'number' ? cp.dropCount : 0, manual: cp.manual === true }
    });
    cpPlaced = true;
  };
  const isCpMessage = (ev) => ev.seq <= (cp?.dropThroughSeq ?? -1); // 被压缩区间的消息:显示上仍完整保留
  for (const ev of events) {
    const d = ev.data || {};
    if (ev.type === 'tool/call') {
      calls.set(d.callId, d);
    } else if (ev.type === 'user/message') {
      if (!cpPlaced && !isCpMessage(ev)) placeCp(); // 保留区首条消息面事件前插压缩标记行
      alive = new Set(); // user 之后工具 id 失效
      // 运行时上下文快照(source='runtime')仅供模型历史消费(deriveMessages 读事件日志),
      // 不投影到前端,避免聊天里出现「⚙ 运行时上下文已更新」这类内部占位气泡
      if (d.source === 'runtime') continue;
      out.push({
        // 前端显示用户原文;带注入技能时它携纯原文(display),模型历史才用注入后的 content
        role: 'user', content: d.display ?? d.content,
        // 事件时间戳随投影下发,前端据此显示"今天/昨天/日期+时间"
        time: ev.time,
        // 附件元数据随历史回放,前端渲染缩略图/文件 chip
        ...(Array.isArray(d.attachments) && d.attachments.length ? { attachments: d.attachments } : {}),
        // 手动调用技能注入的技能详情随历史回放,前端可恢复"已加载技能"折叠行
        ...(Array.isArray(d.skillsInjected) && d.skillsInjected.length ? { skillsInjected: d.skillsInjected } : {})
      });
    } else if (ev.type === 'compaction/done') {
      // 旧版破坏式压缩遗留(无生效检查点,早期消息已被物理删除):原位投影标记行;
      // 新版检查点已由 placeCp 统一在保留区首条前插入,这里忽略避免重复。
      if (!cp) {
        alive = new Set();
        out.push({
          role: 'user', content: d.summary || '【上下文已自动压缩】早期对话已省略。', time: ev.time,
          compaction: { dropCount: typeof d.dropCount === 'number' ? d.dropCount : 0, manual: d.manual === true }
        });
      }
    } else if (ev.type === 'assistant/message') {
      if (!cpPlaced && !isCpMessage(ev)) placeCp();
      const m = d.message || {};
      alive = new Set((Array.isArray(m.tool_calls) ? m.tool_calls : []).map((t: any) => t.id));
      out.push({
        role: 'assistant',
        content: m.content || '',
        ...(Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls } : {}),
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {})
      });
    } else if (ev.type === 'image/generated') {
      // 生图模型的一轮成图:投影为 assistant 气泡(正文=摘要文本,附件=成图元数据)。
      // 前端 turnsToMessages 会把它并入紧邻的 assistant 消息(同一条 run 的多轮合并),
      // 因此刷新后成图与摘要显示在同一个气泡里。
      if (!cpPlaced && !isCpMessage(ev)) placeCp();
      alive = new Set(); // 生图轮不含工具调用
      out.push({
        role: 'assistant',
        content: imageCaption({ mode: d.mode === 'i2i' ? 'i2i' : 't2i', refs: d.refs, size: d.size, count: (d.attachments || []).length || 1 }),
        time: ev.time,
        imageJob: { mode: d.mode === 'i2i' ? 'i2i' : 't2i', refs: typeof d.refs === 'number' ? d.refs : undefined, ms: d.ms },
        ...(Array.isArray(d.attachments) && d.attachments.length ? { attachments: d.attachments } : {})
      });
    } else if (ev.type === 'tool/result') {
      if (!cpPlaced && !isCpMessage(ev)) placeCp();
      if (!alive.has(d.callId)) continue; // 孤儿工具结果:不投影
      alive.delete(d.callId);
      const c = calls.get(d.callId) || {};
      out.push({
        role: 'tool', tool_call_id: d.callId, content: d.content,
        tool_name: d.name || c.name, tool_args: c.arguments, ok: !d.isError, ms: d.ms,
        ...(d.meta !== undefined ? { meta: d.meta } : {})
      });
    }
  }
  if (!cpPlaced) placeCp(); // 兜底:压缩后无保留区消息(理论上不发生)
  return out;
}

// 第 idx 条"消息面 turn"对应的事件下标定位(与 projectEvents 的投影顺序完全同构)——
// 前面板显示 turns 由 projectEvents 生成,删除/回退/分支拿到的 at 是它的下标,
// 这里必须复刻 projectEvents 的计数口径,否则索引错位会命中错误目标(如把用户消息
// 错配到 assistant,弹「目标不是用户消息」)。同构项:
// - source='runtime' 的 user/message 快照不投影前端,不计数;
// - 孤儿 tool/result(无前置 assistant tool_calls)不投影,不计数;
// - 生效压缩检查点(最后一条带 dropThroughSeq 的 compaction/done)的标记行计在
//   "保留区首条消息面之前",返回检查点事件本身的下标(删除/回退它 = 取消压缩);
// - 非生效的旧 compaction/done 事件不计。
export function messageFaceIndexes(events) {
  let cp = null, cpIdx = -1; // 生效检查点(同 projectEvents)
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'compaction/done' && typeof ev.data?.dropThroughSeq === 'number') { cp = ev.data; cpIdx = i; }
  }
  const out = [];
  let alive = new Set(); // 最近 assistant 声明的存活 tool_call id(孤儿 tool/result 过滤)
  let cpDone = !cp;
  const placeCp = () => { if (!cpDone) { out.push(cpIdx); cpDone = true; } };
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const d = ev.data || {};
    if (ev.type === 'user/message') {
      if (d.source === 'runtime') continue; // 快照不投影前端
      alive = new Set();
      if (!cpDone && ev.seq > (cp?.dropThroughSeq ?? -1)) placeCp(); // 保留区首条消息面前插标记行
      out.push(i);
    } else if (ev.type === 'assistant/message') {
      if (!cpDone && ev.seq > (cp?.dropThroughSeq ?? -1)) placeCp();
      alive = new Set((Array.isArray(d.message?.tool_calls) ? d.message.tool_calls : []).map((t: any) => t.id));
      out.push(i);
    } else if (ev.type === 'image/generated') {
      // 与 projectEvents 严格同构:生图成图也投影为一条 assistant turn,这里必须计数,
      // 否则删除/回退/分支拿到的下标整体错位(如把用户消息错配成 assistant)。
      if (!cpDone && ev.seq > (cp?.dropThroughSeq ?? -1)) placeCp();
      alive = new Set();
      out.push(i);
    } else if (ev.type === 'tool/result') {
      if (!cpDone && ev.seq > (cp?.dropThroughSeq ?? -1)) placeCp();
      if (!alive.has(d.callId)) continue; // 孤儿结果不投影
      alive.delete(d.callId);
      out.push(i);
    } else if (ev.type === 'compaction/done') {
      if (!cp) { // 旧版破坏式压缩遗留(无生效检查点):原位投影标记行
        alive = new Set();
        out.push(i);
      }
      // 生效检查点:忽略(位置由 placeCp 覆盖)
    }
  }
  if (!cpDone) placeCp(); // 兜底:保留区无消息面时标记行收尾
  return out;
}

// 定位第 idx 条"消息面 turn"对应的事件结束位置(idx 语义 = 前端 turns 下标);
// 找不到返回 -1。供分支(fork)切片使用。
function cutAtTurn(events, idx) {
  const i = messageFaceIndexes(events)[idx];
  return i === undefined ? -1 : i + 1;
}

// 定位第 idx 条"消息面 turn"对应的事件数组下标(idx 语义 = 前端 turns 下标);
// 找不到返回 -1。供删除/回退单条用户消息使用。
function findTurnEvent(events, idx) {
  const i = messageFaceIndexes(events)[idx];
  return i === undefined ? -1 : i;
}

// 事件数组过滤/截断后重排 seq(与 Session 构造对齐:seq = 新数组下标,time 缺失补当前时间)
function reindexEvents(events) {
  return events.map((ev, i) => ({ seq: i, time: ev.time ?? Date.now(), type: ev.type, data: ev.data }));
}

export class Agent {
  emit: (event: string, payload: any, extra?: any) => void;
  llm: LlmClient | null = null; // 由 llm 配置设置(全会话共享)
  llmConfigured = false;
  sessionId: string | null = null; // 当前活跃(前端正在查看)会话 id
  _runtimes: Map<string, any> = new Map(); // sessionId -> 运行时;多会话各自独立驱动、可并行
  _chatOnlyUntil = 0; // 工具降级纯对话的失效时间戳(带 TTL,见 _chatOnly getter)
  _connKey: string = 'local'; // 会话作用域:连接时 = 服务器键(username@host:port),否则本地工作区模式

  constructor({ emit }: { emit: (event: string, payload: any, extra?: any) => void }) {
    this.emit = emit;            // (event, payload) => void,由 ws 层转发给前端
    this.llm = null;            // LlmClient,由 llm 配置设置(全会话共享)
    this.llmConfigured = false;
    this.sessionId = null;      // 当前活跃(前端正在查看)会话 id
    this._runtimes = new Map(); // sessionId -> 运行时;多会话各自独立驱动、可并行
    this._chatOnlyUntil = 0;    // 工具降级纯对话的失效时间戳(带 TTL,见 _chatOnly getter)
    this._connKey = 'local';    // 会话作用域:连接时 = 服务器键(username@host:port),否则本地工作区模式
    this._restore();
  }

  // 模型不支持工具调用时短暂降级为纯对话,但带 TTL(AGENT.CHAT_ONLY_TTL_MS):
  // 网关临时故障(渠道切换/限流等)不会把会话永久打成纯对话,超时后自动重试工具调用。
  // 若模型确实不支持工具,降级在每次重试失败时重新触发并再次提示。
  get _chatOnly() {
    return this._chatOnlyUntil > Date.now();
  }

  // 服务重启后恢复会话:接住上次活跃会话,但只在该会话属于当前作用域(默认本地模式)时生效,
  // 否则回落到当前作用域最近使用的会话,都没有则新建(失败静默,等价于空会话)
  _restore() {
    try {
      const mine = sessions.list(this._connKey);
      const target = mine.find((s) => s.id === sessions.getActive()) || mine[0]
        || sessions.create('新会话', this.sessionConnKey(), this._captureBinding());
      this.sessionId = target.id;
      this._runtimes.set(target.id, newRuntime(new Session(sessions.loadEvents(target.id))));
      sessions.setActive(target.id);
      this._applySessionBinding(target.id); // 恢复的会话把绑定工作区重新应用到活动连接
    } catch (e) {
      console.error('[agent] 恢复会话失败:', e.message);
      this.sessionId = null;
    }
  }

  // 会话归属作用域:有远程工作区(或明确选择「不在工作区对话」=整台服务器)= 当前连接作用域;
  // 否则 = 本地作用域。连接了 SSH 但两侧都没选的会话仍归本地——它只在本机工作(见 createSession)。
  sessionConnKey() {
    return ssh.workspace || ssh.noWorkspace ? this._connKey : 'local';
  }

  /**
   * 把指定会话的绑定工作区(远程/本地)应用到自身运行时与活动连接:
   * - rt.workspace / rt.localWorkspace 总是同步(执行时经作用域生效,后台并行隔离);
   * - 仅当 id 是当前活跃会话、且绑定值非空时才写 ssh.workspace / localFs.workspace——
   *   切到无绑定的旧会话不清空当前连接工作区,避免误伤其他会话的执行目录。
   */
  _applySessionBinding(id: string) {
    const meta = sessions.list().find((s) => s.id === id);
    if (!meta) return;
    const rt = this._runtimes.get(id);
    if (rt) {
      rt.workspace = meta.workspace ?? null;
      rt.localWorkspace = meta.localWorkspace ?? null;
      rt.connKey = meta.connKey ?? null;
    }
    if (id === this.sessionId) {
      if (meta.workspace != null) this._applyRemoteBinding(meta.workspace);
      if (meta.localWorkspace != null) this._applyLocalBinding(meta.localWorkspace);
    }
  }

  // 捕获"当前的工作区选择"作为新会话绑定值:全盘模式记为哨兵 NO_WORKSPACE,
  // 这样在草稿态选了「不在工作区对话」,首条消息创建的会话会继承该模式。
  _captureBinding(): { workspace: string | null; localWorkspace: string | null } {
    return {
      workspace: ssh.noWorkspace ? NO_WORKSPACE : (ssh.workspace ?? null),
      localWorkspace: localFs.noWorkspace ? NO_WORKSPACE : (localFs.workspace ?? null)
    };
  }

  // 把绑定值(路径 / 全盘哨兵)写到活动连接:哨兵 = 清空工作区并置「不在工作区对话」标记
  _applyRemoteBinding(ws: string) {
    if (ws === NO_WORKSPACE) ssh.noWorkspace = true;
    else ssh.workspace = ws;
  }

  // 把本地绑定值(路径 / 全盘哨兵)写到本地工作区状态
  _applyLocalBinding(ws: string) {
    if (ws === NO_WORKSPACE) localFs.noWorkspace = true;
    else localFs.workspace = ws;
  }

  // 当前活跃会话的事件日志(活跃会话必有运行时)
  get session() {
    return this._runtimes.get(this.sessionId)?.session || EMPTY_SESSION;
  }

  // 派生的 LLM 消息历史(活跃会话;带预算裁剪;兼容外部直接读 .history 的用法)
  get history() {
    return this.session.deriveMessages({ budgetChars: AGENT.HISTORY_BUDGET_CHARS });
  }

  // 前端渲染投影:事件日志 -> 消息数组(工具消息附带 tool_name/tool_args/ok/ms)
  // 运行中的会话直接取其内存日志(含未落盘的进行中事件),空闲会话从磁盘载入。
  // 运行中且模型正在流式输出时,当前步的回复尚未写成 assistant/message 事件
  // (只在 onDelta 推给前端),这里从 runtime 的 live 半成品缓冲补一条合成消息,
  // 否则切回运行中的会话时整表替换会把"正在生成的部分内容"从视图上弄丢。
  getHistory(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    const events = rt ? rt.session.events : (id != null ? sessions.loadEvents(id) : []);
    const turns = projectEvents(events);
    if (rt?.busy && rt.live && (rt.live.content || rt.live.reasoning)) {
      turns.push({
        role: 'assistant',
        content: rt.live.content || '',
        ...(rt.live.reasoning ? { reasoning_content: rt.live.reasoning } : {})
      });
    }
    return turns;
  }

  // 当前任务计划(todo/write 投影):最新整表,turn/start 清空(见 foldTodos)
  currentTodos(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    const events = rt ? rt.session.events : (id != null ? sessions.loadEvents(id) : []);
    return foldTodos(events) || [];
  }

  // ---- 访问权限模式(变更前确认/自动编辑/计划模式/完全访问,见 permission.ts) ----
  // 模式持久化在会话事件日志('permission/mode' 事件):运行中会话直接追加并落盘,
  // 不在内存的会话(切走后释放)从磁盘载入-追加-保存;切换即广播 permission_changed。
  // 全局默认模式(settings-store)兜底:会话日志里没有 mode 事件(新建/清空过历史)
  // 时,新会话直接继承用户最近一次设置的档位——设置为完全访问后,所有新会话都是完全访问。
  getPermissionMode(id = this.sessionId): PermissionMode {
    if (id == null) return this.getDefaultPermissionMode();
    const rt = this._runtimes.get(id);
    return foldPermissionMode(rt ? rt.session.events : sessions.loadEvents(id), this.getDefaultPermissionMode());
  }

  /** 全局默认访问权限模式(settings-store 持久化,新会话继承;未设置回落 confirm) */
  getDefaultPermissionMode(): PermissionMode {
    const m = storeDefaultMode();
    return isPermissionMode(m) ? m : DEFAULT_PERMISSION_MODE;
  }

  setPermissionMode(mode: PermissionMode, id = this.sessionId): PermissionMode {
    if (id == null) throw new Error('当前没有可操作的会话');
    const rt = this._runtimes.get(id);
    if (rt) {
      rt.session.append('permission/mode', { mode });
      sessions.saveEvents(id, rt.session.events); // 运行中会话也立即落盘,重启后模式不丢
    } else {
      const events = sessions.loadEvents(id);
      events.push({ seq: events.length, time: Date.now(), type: 'permission/mode', data: { mode } });
      sessions.saveEvents(id, events);
    }
    // 用户设置的档位同时持久化为全局默认:新建会话即继承该模式
    if (isPermissionMode(mode)) storeSetDefaultMode(mode);
    this.emit('agent', { event: 'permission_changed', mode, sid: id });
    return mode;
  }

  /**
   * 从当前活跃会话创建分支(照搬 harness 的 forkAt 语义):
   * turnIndex 为消息数组(turns 投影)中的索引,>=0 时克隆到该条消息为止的事件日志
   * (截断其后的消息,从分支点另起炉灶);缺省 -1 克隆整个会话。
   * 原会话原封不动,用户可沿另一方向继续。
   * 克隆时 Session 构造的 _heal 会给进行中的工具调用补"中止"结果,快照永远可回放。
   */
  forkSession(turnIndex = -1) {
    const srcId = this.sessionId;
    if (!srcId || !sessions.exists(srcId)) throw new Error('当前没有可分支的会话');
    const rt = this._runtimes.get(srcId);
    const events = rt ? rt.session.events : sessions.loadEvents(srcId);
    // 分支截断点:第 turnIndex 条"消息面 turn"(user/message、compaction/done、
    // assistant/message、tool/result)对应的事件结束位置;turnIndex<0 表示从尾部整体克隆
    let cut = events.length;
    if (turnIndex >= 0) {
      const at = cutAtTurn(events, turnIndex);
      if (at < 0) throw new Error('分支点无效:目标消息不在当前会话中');
      cut = at;
    }
    const log = events.slice(0, cut);
    const srcMeta = sessions.list().find((s) => s.id === srcId);
    // 分支标题:剥离旧的分支后缀后重新编号,避免 "(分支)" 层层叠加
    const srcTitle = (srcMeta?.title || '新会话')
      .replace(/\s*\(分支(\d+)?\)\s*$/, '').trim() || '新会话';
    const taken = new Set(sessions.list().map((s) => s.title));
    let title = `${srcTitle} (分支)`;
    for (let n = 2; taken.has(title); n++) title = `${srcTitle} (分支${n})`;
    // 分支继承源会话的作用域与工作区绑定(本地分支保持本地,远程分支保持远程)
    const s = sessions.create(title, srcMeta?.connKey ?? this.sessionConnKey(), {
      workspace: srcMeta?.workspace ?? null,
      localWorkspace: srcMeta?.localWorkspace ?? null
    });
    const cloned = new Session(log.map((e) => ({ type: e.type, data: e.data, time: e.time })));
    sessions.saveEvents(s.id, cloned.events);
    this._runtimes.set(s.id, newRuntime(cloned));
    this.sessionId = s.id;
    this._applySessionBinding(s.id); // 分支继承源会话的工作区绑定
    this.emit('agent', { event: 'session_switched', id: s.id });
    this.emit('agent', { event: 'sessions_changed' });
    return s;
  }

  // 当前活跃会话 id
  getSessionId() { return this.sessionId; }

  // 切换会话作用域(连接服务器 / conn_switch / 断开回本地模式):
  // key 不变则无操作(同一服务器重连保持当前会话);变化时把活跃会话切到新作用域
  // 最近使用的会话,无则自动新建。由 ws 层在连接状态变化时调用。
  setConnKey(key) {
    const k = key || 'local';
    if (k === this._connKey) return;
    this._connKey = k;
    this._settleActive();
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 把活跃会话收敛到当前作用域:当前 sessionId 已属于该作用域则不动,
  // 否则切换到最近使用(或新建)的本作用域会话,并同步磁盘 active。
  _settleActive() {
    const mine = this.listSessions();
    if (mine.some((s) => s.id === this.sessionId)) return;
    const target = mine[0] || sessions.create('新会话', this.sessionConnKey(), this._captureBinding());
    let rt = this._runtimes.get(target.id);
    if (!rt) rt = newRuntime(new Session(sessions.loadEvents(target.id)));
    this._runtimes.set(target.id, rt);
    this.sessionId = target.id;
    sessions.setActive(target.id);
    this._applySessionBinding(target.id); // 收敛到的会话把绑定工作区应用到活动连接
    this.emit('agent', { event: 'session_switched', id: target.id });
  }

  // 会话列表:只返回当前作用域(连接的服务器 / 本地工作区)的会话
  listSessions() { return sessions.list(this._connKey); }

  // 新建会话并切为活跃。
  // 归属作用域按"是否选了远程工作区"决定:选了 → 归当前服务器(远程任务列表);
  // 没选(即使已连接 SSH)→ 归本地作用域(本地任务列表,仅本地工作区对话,见需求)。
  // 新建时捕获"当时的连接工作区"作为会话绑定:之后在新会话里改工作区,
  // 只改本会话的绑定,不串改其他会话的执行工作区。
  createSession(title) {
    const s = sessions.create(title, this.sessionConnKey(), this._captureBinding());
    const rt = newRuntime(new Session());
    rt.workspace = s.workspace ?? null;
    rt.localWorkspace = s.localWorkspace ?? null;
    rt.connKey = s.connKey ?? null;
    this._runtimes.set(s.id, rt);
    this.sessionId = s.id;
    this.emit('agent', { event: 'session_switched', id: s.id });
    return s;
  }

  // 切换到指定会话:运行中的会话直接复用其内存事件日志(含进行中未落盘的事件),
  // 切回去即可看到任务进行中的状态;切走的空闲会话释放内存,下次从磁盘载入。
  switchSession(id) {
    if (!sessions.exists(id)) throw new Error(`会话不存在: ${id}`);
    const prevId = this.sessionId;
    let rt = this._runtimes.get(id);
    if (!rt) {
      rt = newRuntime(new Session(sessions.loadEvents(id)));
      this._runtimes.set(id, rt);
    }
    this.sessionId = id;
    sessions.setActive(id);
    if (prevId && prevId !== id) {
      const prev = this._runtimes.get(prevId);
      if (prev && !prev.busy) this._runtimes.delete(prevId); // 空闲会话磁盘即最新
    }
    this._applySessionBinding(id); // 切回的会话把绑定工作区应用到活动连接(UI 自动跟随)
    this.emit('agent', { event: 'session_switched', id });
  }

  // 会话是否"已开始对话"(有用户发起的第一条消息)。锁定的依据:
  // 读运行时内存日志(含进行中未落盘的),不依赖索引 msgCount(它在轮末落盘时才更新,
  // 首轮对话期间会误判为未开始)。
  sessionStarted(id: string | null): boolean {
    if (!id) return false;
    const rt = this._runtimes.get(id);
    const events: any[] = rt ? rt.session.events : sessions.loadEvents(id);
    return events.some((e) => e?.type === 'user/message' && e.data?.source === 'user');
  }

  // 远程工作区锁定校验:任何已开始对话的会话都不能再改远程工作区
  // (远程会话锁定主工作区;本地会话锁定后只能本地工作,也不允许再"补"远程工作区)。
  assertRemoteWorkspaceChangeable(id: string | null) {
    if (!id) return;
    if (this.sessionStarted(id)) {
      throw new Error('该会话已开始对话,远程工作区已锁定,不能修改;如需更换工作区请新建会话');
    }
  }

  // 本地工作区锁定校验:仅"本地模式会话(无远程工作区)"在开始对话后锁定本地工作区;
  // 远程会话的本地工作区是辅助工作区,始终可改。
  assertLocalWorkspaceChangeable(id: string | null) {
    if (!id) return;
    if (this.sessionStarted(id)) {
      const meta = sessions.list().find((s) => s.id === id);
      if (meta && (meta.workspace ?? null) == null) {
        throw new Error('该本地会话已开始对话,本地工作区已锁定,不能修改;如需更换工作区请新建会话');
      }
    }
  }

  // 更新当前会话绑定的远程工作区:写入会话元数据(持久化)+ 运行时;
  // id 为空(草稿态,服务端尚无该会话)时不绑定任何会话,只影响连接级工作区。
  updateSessionWorkspace(id: string | null, ws: string | null) {
    this.assertRemoteWorkspaceChangeable(id); // 已开始对话的会话锁定(防御:RPC 已先校验)
    if (!id) return;
    sessions.setWorkspace(id, ws);
    // 空会话补选远程工作区(含「不在工作区对话」)后,从本地作用域翻转为当前服务器作用域(归类随工作区走)
    if (ws != null && this._connKey !== 'local') sessions.setConnKey(id, this._connKey);
    const rt = this._runtimes.get(id);
    if (rt) {
      rt.workspace = ws;
      // 补选远程工作区后会话翻转到本服务器作用域:运行时同步归属,新一轮据此绑定连接
      if (ws != null && this._connKey !== 'local') rt.connKey = this._connKey;
    }
    if (id === this.sessionId && ws != null) this._applyRemoteBinding(ws);
    this.emit('agent', { event: 'sessions_changed' }); // 前端据此把会话移到对应工作区分组
  }

  // 更新当前会话绑定的本地工作区(本地模式会话开始对话后锁定;远程会话的本地工作区可作辅助随时改)
  updateSessionLocalWorkspace(id: string | null, lws: string | null) {
    this.assertLocalWorkspaceChangeable(id); // 防御:RPC 已先校验
    if (!id) return;
    sessions.setLocalWorkspace(id, lws);
    const rt = this._runtimes.get(id);
    if (rt) rt.localWorkspace = lws;
    if (id === this.sessionId && lws != null) this._applyLocalBinding(lws);
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 删除会话:允许删除当前活跃会话(删除后活跃收敛到本作用域最近剩余会话,
  // 无剩余则自动新建空会话接住,前端在草稿态不会采纳该收敛结果);
  // 运行中的会话禁止删除(防破坏进行中的事件写入)。
  deleteSession(id) {
    const rt = this._runtimes.get(id);
    if (rt?.busy) throw new Error('会话任务进行中,请先停止再删除');
    this._runtimes.delete(id);
    sessions.remove(id);
    if (id === this.sessionId) this._settleActive();
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 重命名会话
  renameSession(id, title) {
    sessions.rename(id, title);
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 清空指定会话历史(内存 + 磁盘);运行中的会话禁止清空
  clearHistory(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    if (rt?.busy) throw new Error('会话正在运行,请先停止或等待完成');
    if (id != null) {
      this._runtimes.set(id, newRuntime(new Session()));
      sessions.saveEvents(id, []);
    }
    this.emit('agent', { event: 'history_cleared' });
    this.emit('agent', { event: 'sessions_changed' });
  }

  /**
   * 删除一条用户消息(at 为消息面 turn 索引,与前端 forkTail 对齐):
   * - 用户发起消息(user/message source='user'):删除整轮(turn/start..turn/end,
   *   即该条消息与 AI 对它的整轮回复)
   * - 运行中注入(steer/goal_round):只删除该条注入消息,不拆散所在轮
   * - 压缩摘要(compaction/done):删除该摘要
   * 运行中的会话禁止删除(等待 idle,避免破坏进行中的事件写入)。
   */
  deleteMessageAt(at) {
    const rt = this._runtimes.get(this.sessionId);
    if (!rt) throw new Error('当前没有可操作的会话');
    if (rt.busy) throw new Error('会话正在运行,请先停止或等待完成');
    const session = rt.session;
    const events = session.events;
    const idx = findTurnEvent(events, at);
    if (idx < 0) throw new Error(`目标消息不存在(at=${at},消息面数=${messageFaceIndexes(events).length})`);
    const ev = events[idx];
    let kept;
    if (ev.type === 'user/message' && ev.data.source === 'user') {
      // 用户发起消息:删除其所在整轮。注意 user/message 事件本身不带 data.turn,
      // 需按事件区间定位:最近的 turn/start 起,到配对 turn/end 止。
      let s = idx;
      while (s > 0 && events[s - 1].type !== 'turn/start') s--;
      const turnStartIdx = s - 1;
      if (turnStartIdx < 0) throw new Error('目标消息不在任何一轮内');
      const turn = events[turnStartIdx].data.turn;
      let e = turnStartIdx + 1;
      while (e < events.length && !(events[e].type === 'turn/end' && events[e].data.turn === turn)) e++;
      if (e >= events.length) throw new Error('目标轮未闭合,无法删除');
      kept = events.filter((_, i) => i < turnStartIdx || i > e);
    } else {
      // 注入消息 / 压缩摘要:只删这一条
      kept = events.filter((_, i) => i !== idx);
    }
    session.events = reindexEvents(kept);
    if (this.sessionId) sessions.saveEvents(this.sessionId, session.events);
    this.emit('agent', { event: 'sessions_changed' });
  }

  /**
   * 回到本轮对话发起前(at 为消息面 turn 索引):截断事件日志到该条消息所属轮
   * 发起(turn/start)之前,移除该条消息及其之后的所有对话;该条是首条时等价于清空。
   */
  rewindToBefore(at) {
    const rt = this._runtimes.get(this.sessionId);
    if (!rt) throw new Error('当前没有可操作的会话');
    if (rt.busy) throw new Error('会话正在运行,请先停止或等待完成');
    const session = rt.session;
    const events = session.events;
    const idx = findTurnEvent(events, at);
    if (idx < 0) throw new Error(`目标消息不存在(at=${at},消息面数=${messageFaceIndexes(events).length})`);
    const ev = events[idx];
    let cut;
    if (ev.type === 'compaction/done') {
      // 摘要消息:回到它之前,摘要本身及其后的内容一并移除
      cut = idx;
    } else if (ev.type === 'user/message') {
      // 回溯到该条消息所属轮的 turn/start(本轮对话发起);首条无轮则从 0 截断
      let j = idx;
      while (j > 0 && events[j - 1].type !== 'turn/start') j--;
      cut = j > 0 ? j - 1 : 0;
    } else {
      throw new Error('目标不是用户消息,无法回退');
    }
    session.events = reindexEvents(events.slice(0, cut));
    if (this.sessionId) sessions.saveEvents(this.sessionId, session.events);
    this.emit('agent', { event: 'sessions_changed' });
  }

  // 手动压缩当前会话上下文(/compact 命令,移植自 harness 的 command-compact):
  // 无条件把早期区间压缩成一段结构化 checkpoint 摘要并 squash 进日志,不依赖自动压缩的阈值水位;
  // 保留最近一段(最高 contextWindow×16%,多组对话时至少保留最后一组),区间选择
  // 与自动压缩同款(位置式 selectCompactRange);单条消息的深任务现在也能手动压缩。
  // 运行中的会话禁止压缩(等待 idle),压缩完成后广播 history_compacted 事件供前端刷新。
  // 失败语义对齐 harness compactNow:摘要生成失败或摘要不小于被压缩区间(shrink 校验)
  // 时抛错并保留会话原样,绝不清空历史;前端据此渲染命令卡失败态。
  /**
   * @param {string} [id] 会话 id,默认当前活跃会话
   * @returns {Promise<{compacted: boolean, dropCount: number, summary?: string}>}
   */
  async compactNow(id = this.sessionId) {
    if (id == null) throw new Error('当前没有可压缩的会话');
    const rt = id != null ? this._runtimes.get(id) : null;
    if (rt?.busy) throw new Error('会话正在运行,请先停止或等待完成');
    // 目标会话可能已从内存释放(切走时空闲 runtime 被回收):按该会话自己的磁盘日志重建。
    // 绝不回落 this.session——那会把用户正在看的另一个会话压缩后写进本 id 的文件。
    const session = rt ? rt.session : new Session(sessions.loadEvents(id));
    if (!this.llm || this.llm.isMock) throw new Error('尚未配置可用的 LLM,无法生成摘要');
    const trace = session.deriveMessagesWithTrace({ budgetChars: Infinity });
    const msgs = trace.map((t) => t.msg);
    if (msgs.length < 3) return { compacted: false, dropCount: 0 };

    // 手动压缩保留最近一段(比自动压缩更克制:多组对话时至少保留完整最后一组)
    const ctxWindow = this.llm.contextWindow || 128000;
    const retainTokens = Math.max(Math.floor(ctxWindow * 0.16), 4000);
    let range = selectCompactRange(msgs, retainTokens);
    if (!range) {
      // 位置式选择无可压缩区间(历史很小,全在保留水位内):旧语义兜底——
      // 至少把除最后一组外的早期对话全部压缩掉,保证 /compact 在小组会话上仍有收益
      const groupStarts: number[] = [];
      msgs.forEach((m, i) => { if (m.role === 'user') groupStarts.push(i); });
      if (groupStarts.length >= 2) {
        const cut = groupStarts[groupStarts.length - 1];
        if (cut > 0) range = { drop: msgs.slice(0, cut), recent: msgs.slice(cut) };
      }
    }
    if (!range) return { compacted: false, dropCount: 0 };
    // 多组对话:切点不越过最后一组起点(至少保留完整最后一组);
    // 单组对话(单消息深任务):直接用位置式切点,允许压缩组内早期步骤
    const firstUserIdx = msgs.findIndex((m) => m.role === 'user');
    const lastUserIdx = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const keep = firstUserIdx >= 0 && firstUserIdx === lastUserIdx
      ? range.drop.length
      : Math.min(range.drop.length, lastUserIdx);
    if (keep <= 0 || keep >= msgs.length) return { compacted: false, dropCount: 0 };
    const dropMsgs = msgs.slice(0, keep);
    if (!dropMsgs.length) return { compacted: false, dropCount: 0 };

    let summary = '';
    if (!this.llm.isMock && this.llmConfigured) {
      // 摘要生成失败直接抛错、保留会话原样(对齐 harness compactNow 的 ManualCompactionError:
      // 手动压缩失败不清空历史,前端命令卡显示失败原因;「降级直接裁剪」只留给自动压缩兜底)
      summary = await summarizeWithLlm({
        llm: this.llm, system: this._systemPrompt('off'), dropMsgs, signal: new AbortController().signal
      });
    }
    // shrink 校验(对齐 harness compaction-basic region.ts):摘要必须比被压缩区间更小,
    // 否则压缩无收益——同样抛错保留原样,不降级裁剪
    if (summary && estimateTokens(summary) >= measureMessages(dropMsgs)) {
      throw new Error(`压缩失败:生成的摘要(${Math.round(estimateTokens(summary))} token)不小于被压缩内容(${Math.round(measureMessages(dropMsgs))} token),会话历史保持不变`);
    }
    const summaryMsg = summary
      ? `【上下文已手动压缩】为节省上下文窗口,早期对话被压缩为以下摘要(如需细节请让助手展开):\n${summary}`
      : `【上下文已手动压缩】早期 ${dropMsgs.length} 条消息已省略。`;
    const dropSeqs = trace.slice(0, keep).map((t) => t.seq);
    // 非破坏压缩:日志完整保留早期消息(前端显示/刷新后回看始终完整),
    // 只追加压缩检查点,模型历史投影自检查点起跳过被压消息、以摘要顶替。
    session.markCompacted(dropSeqs, summaryMsg, { dropCount: dropMsgs.length, manual: true });
    if (!rt) this._runtimes.set(id, newRuntime(session)); // 压缩结果同步进内存,避免下次载入前被旧快照覆盖
    if (id != null) sessions.saveEvents(id, session.events); // 落盘,重启/切回会话后仍在
    this.emit('agent', { event: 'history_compacted', sid: id, dropCount: dropMsgs.length });
    return { compacted: true, dropCount: dropMsgs.length, summary: summaryMsg };
  }

  configureLlm(cfg) {
    this.llm = new LlmClient(cfg || {});
    this.llmConfigured = Boolean(this.llm && !this.llm.isMock ? this.llm.apiKey : true);
    this._chatOnlyUntil = 0; // 换了模型,清除"不支持工具"降级标记,给新模型重新尝试工具的机会
    this.emit('llm', { configured: true, model: this.llm.model, mock: this.llm.isMock });
  }

  // 停止指定会话的当前轮(默认当前活跃会话);未消费的注入一并作废
  stop(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    if (!rt) return;
    if (rt.signal) {
      try { rt.signal.abort(); } catch {}
    }
    rt.steer.length = 0;
  }

  // 停止所有运行中的会话(SSH 断开等全局异常时)
  stopAll() {
    for (const rt of this._runtimes.values()) {
      if (rt.signal) {
        try { rt.signal.abort(); } catch {}
      }
      rt.steer.length = 0;
    }
  }

  // 只停止绑定到指定连接的会话(那台服务器断开/掉线;其他服务器的后台运行不受影响)
  stopForConn(conn) {
    if (!conn) return;
    for (const rt of this._runtimes.values()) {
      if (rt.boundConn !== conn) continue;
      if (rt.signal) {
        try { rt.signal.abort(); } catch {}
      }
      rt.steer.length = 0;
    }
  }

  // 前台可见的会话列表:
  // - 当前作用域的会话 + 本地模式会话(connKey='local')始终可见——连接服务器时
  //   本地任务列表不被隐藏,与远程任务列表分开显示;
  // - 其他作用域(其他服务器)仍在运行的会话(后台任务可见),带 connKey 标注所属服务器。
  listVisible() {
    const mine = sessions.list(this._connKey);
    const byId = new Map(mine.map((s) => [s.id, s]));
    // 连接服务器时补上本地模式会话;本地模式本身已是当前作用域,无需重复
    if (this._connKey !== 'local') {
      for (const s of sessions.list('local')) {
        if (!byId.has(s.id)) byId.set(s.id, s);
      }
    }
    for (const [id, rt] of this._runtimes) {
      if (!rt.busy || byId.has(id)) continue;
      const meta = sessions.list().find((s) => s.id === id);
      if (meta) byId.set(id, meta);
    }
    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // 是否有任意会话在运行(兼容旧的单一忙碌语义)
  get busyNow() { return this.busyIds().length > 0; }

  // 运行中的会话 id 列表(前端会话列表显示"运行中"徽标)
  busyIds() {
    return [...this._runtimes].filter(([, rt]) => rt.busy).map(([id]) => id);
  }

  /**
   * 提交一条用户输入到指定会话(= harness 的 followup + wake):
   * 该会话空闲时开新轮;运行中则进入待执行队列(pending),当前轮结束后按 FIFO
   * 自动逐条执行,不再当作 steer 立即打断当前回复。每个会话独立驱动,互不阻塞。
   * 返回的 promise 在该会话整个排空过程(含后续排队的输入)结束后 resolve。
   */
  submit(sessionId, userText, { reasoning = 'default', attachments = null } = {}) {
    if (!this.llm) throw new Error('尚未配置 LLM(设置 -> 模型配置)');
    const rt = sessionId != null ? this._runtimes.get(sessionId) : null;
    if (!rt) throw new Error(`会话不存在: ${sessionId}`);
    const text = String(userText);
    const atts = resolveAttachments(attachments);
    if (rt.busy) {
      // 运行中提交:默认进入待执行队列(不打断当前回复);
      // 需要打断当前回复立即执行时,由前端"立即执行"操作走 steerQueueItem(inbox 抢先 + 中止当前轮)
      rt.pending.push({ id: ++rt.queueSeq, text, reasoning, attachments: atts });
      this._emitQueue(rt, sessionId);
      return rt.driving;
    }
    // 空闲提交:先排空上一轮停止后遗留的排队项(保持 FIFO),再执行本次输入
    if (rt.pending.length > 0) {
      while (rt.pending.length > 0) rt.inbox.push(rt.pending.shift());
      this._emitQueue(rt, sessionId);
    }
    rt.inbox.push({ text, reasoning, attachments: atts });
    return this._drive(rt, sessionId);
  }

  // 待执行队列快照(供 get_history / RPC reply:前端按 {id, text} 渲染,attach=附件数)
  queueSnapshot(id = this.sessionId) {
    const rt = id != null ? this._runtimes.get(id) : null;
    return rt ? rt.pending.map((p) => ({ id: p.id, text: p.text, attach: Array.isArray(p.attachments) ? p.attachments.length : 0 })) : [];
  }

  // 队列变化广播:前端据此刷新"等待执行"面板(事件按 sid 路由,只进活跃会话)
  _emitQueue(rt, sid) {
    this.emit('agent', { event: 'queue_update', sid, queue: this.queueSnapshot(sid) });
  }

  /**
   * "立即执行"一条排队消息:从待执行队列取出后立即生效——
   * 会话忙碌时打断当前回复,立即开新轮回复该消息;会话空闲时直接开新轮。
   * 返回最新队列快照供 RPC reply。
   */
  steerQueueItem(id, sid: string | null | undefined = this.sessionId) {
    const rt = sid != null ? this._runtimes.get(sid) : null;
    if (!rt) throw new Error('目标会话不在内存中,请切回该会话后重试');
    const idx = rt.pending.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('该消息不在待执行队列中');
    const [item] = rt.pending.splice(idx, 1);
    if (rt.busy) {
      // 立即执行 = 现在就要答案:把消息插到 inbox 队首并中止正在生成的回复。
      // 当前轮捕获中止后抢救半成品并收尾,drain 随即消费队首直接开新一轮回复该消息,
      // 不等当前回复跑完。旧实现走 steer 的"下一步注入":回复未结束时消息要拖到整轮
      // 跑完才被处理,且前端会收到 steer/start 两个事件把同一消息渲染两遍(已移除 steer 事件)。
      rt.inbox.unshift({ text: item.text, reasoning: item.reasoning, attachments: item.attachments || [] });
      if (rt.signal) { try { rt.signal.abort(); } catch {} }
    } else {
      rt.inbox.push({ text: item.text, reasoning: item.reasoning, attachments: item.attachments || [] });
      this._drive(rt, sid); // 不 await:fire-and-forget,与 speak 一致
    }
    this._emitQueue(rt, sid);
    return { queue: this.queueSnapshot(sid) };
  }

  // 从待执行队列删除一条消息(编辑=移除后由前端撤回输入框);返回最新队列快照
  removeQueueItem(id, sid: string | null | undefined = this.sessionId) {
    const rt = sid != null ? this._runtimes.get(sid) : null;
    if (!rt) throw new Error('目标会话不在内存中,请切回该会话后重试');
    const idx = rt.pending.findIndex((p) => p.id === id);
    if (idx >= 0) rt.pending.splice(idx, 1);
    this._emitQueue(rt, sid);
    return { queue: this.queueSnapshot(sid) };
  }

  // 兼容旧接口:提交到当前活跃会话(运行中自动进入待执行队列)
  run(userText, opts = {}) { return this.submit(this.sessionId, userText, opts); }
  steer(userText, opts = {}) { return this.submit(this.sessionId, userText, opts); }

  // 唤醒某会话的 driver:同一会话同一时刻只有一个驱动在跑,并发提交复用同一个 promise
  _drive(rt, id) {
    if (rt.driving) return rt.driving;
    rt.driving = this._drain(rt, id);
    return rt.driving.finally(() => { rt.driving = null; });
  }

  // driver 主循环:逐条消费该会话的 inbox,每条输入跑完整一轮(Turn)
  async _drain(rt, id) {
    rt.busy = true;
    this.emit('agent', { event: 'status', status: 'running', sid: id });
    try {
      while (rt.inbox.length > 0) {
        const input = rt.inbox.shift();
        const endReason = await this._runTurn(rt, id, input);
        // 上一轮正常结束后,待执行队列按 FIFO 自动补齐下一条(一次一条,保持 busy 直至排空);
        // 停止(aborted)只停当前轮,排队项保留,等下次对话正常结束后再执行
        if (endReason && endReason.kind !== 'aborted' && rt.pending.length > 0) {
          rt.inbox.push(rt.pending.shift());
          this._emitQueue(rt, id);
        }
      }
    } finally {
      rt.busy = false;
      rt.signal = null;
      rt.boundConn = null;
      this.emit('agent', { event: 'status', status: 'idle', sid: id });
    }
  }

  /**
   * 一轮完整交互(Turn):turn/start -> 若干步(step/start -> 模型请求 ->
   * assistant/message -> 工具调用与结果 -> step/end) -> turn/end。
   * 结束时事件日志落盘;中止/异常时给未闭合的工具调用补结果,保证日志永远可回放。
   * 事件全部携带 sid:前端按会话路由显示,多会话并行互不串扰。
   */
  async _runTurn(rt, runSessionId, input) {
    // 本轮开始时把会话绑定到**它自己所属服务器**的连接(按 rt.connKey 解析,而不是
    // "界面当前在看的那台"):之后用户切走/切回其它服务器,本轮的模型提示词与所有工具
    // 调用仍作用于这台服务器,后台继续运行不中断。
    // 为什么不能取 ssh.active:排队消息/后台续轮常在用户切走之后才开始,按活动连接绑定
    // 会把整轮工具打到另一台服务器上(路径与命令全跑错机器),并且那台服务器一旦断开,
    // stopForConn 会把这个会话连带中止——表现为"在 B 上操作,A 的对话被中断"。
    // 归属服务器取不到连接就是没连上:直接报错,不借用别的连接执行。
    // 仅"远程模式会话(绑定了远程工作区)"绑定连接;本地模式会话不绑任何连接——连接
    // 断开不会连带停止它,远程工具也因无工作区而不可用。
    // 同时把会话绑定的远程/本地工作区套上作用域:并行会话各自读到自己绑定的工作区
    // (rt.workspace 等),互不串改;undefined = 无绑定(旧会话),回落连接级工作区。
    // 绑定值为哨兵 NO_WORKSPACE 时,runWith*WorkspaceBinding 会强制"无工作区 + 全盘模式"。
    let boundConn = null; // 本地模式会话(无远程工作区)= null:不绑连接,连接断开不连带停止它
    if (rt.workspace) {
      boundConn = rt.connKey && rt.connKey !== 'local' ? ssh.connByUserKey(rt.connKey) : ssh.active;
      if (!boundConn) {
        const message = `该会话属于服务器 ${rt.connKey},它当前未连接:本轮未执行。请连回该服务器后重试(不会借用其他服务器执行)`;
        this.emit('agent', { event: 'error', message, sid: runSessionId });
        return { kind: 'error', error: message };
      }
    }
    return ssh.runWithConn(boundConn, () =>
      runWithWorkspaceBinding(rt.workspace, () =>
        runWithLocalWorkspaceBinding(rt.localWorkspace, () =>
          this._runTurnInner(rt, runSessionId, input, boundConn))));
  }

  async _runTurnInner(rt, runSessionId, { text, reasoning, attachments }: { text: string; reasoning: string; attachments?: AttachmentMeta[] | null }, boundConn) {
    const session = rt.session; // 锁定本轮操作的运行时与会话,中途切换活跃会话不影响本轮写入
    const signal = (rt.signal = new AbortController());
    rt.boundConn = boundConn;
    // 附件元数据(submit 时已按服务端索引解析):正文注入与多模态注入都基于它
    const atts: AttachmentMeta[] = Array.isArray(attachments) ? attachments : [];
    const allowVision = !!(this.llm && this.llm.multimodal);

    // 生图模型:整轮旁路(必须在技能注入之前分叉)。纯图像端点模型没有 chat 通道,
    // system 提示词、工具 schema、上下文压缩、/技能 正文注入对它全部无意义,
    // 而且用户原文才是提示词——注入技能会把技能正文混进 prompt 污染出图。
    if (this.llm && this.llm.imageGen) {
      return this._runImageTurn(rt, runSessionId, { text, attachments: atts });
    }

    // /技能名 [需求](对齐 harness tool-skill 的 leadingInput 识别,扩展为任意位置):
    // 输入里独立成词的 /技能名(行首或空白后)逐个加载正文注入本轮,让 AI 严格按技能指令行动;
    // 支持多个技能(去重)。命中技能的 /词 从需求文本中剥除;未命中的原样保留交给模型
    // (它可从会话技能目录中发现正确名称)。路径如 /usr/bin 因 /词 后紧跟非空白不会误命中。
    const rawText = text.trim();
    let injectedSkills = []; // 本轮用户手动调用的技能记录(name+描述+预览,用于记录与前端展示)
    {
      const tokens = []; // 候选 /词:name + 剥除范围 [start, end)
      const re = /(^|\s)(\/\s*[a-z0-9][a-z0-9-]*)(?=\s|$)/gi;
      let m;
      while ((m = re.exec(rawText)) !== null) {
        tokens.push({ name: m[2].replace(/^\/\s*/i, '').toLowerCase(), start: m.index + m[1].length, end: m.index + m[0].length });
      }
      if (tokens.length > 0) {
        const byName = new Map(); // 命中的技能:name -> 技能正文(去重)
        for (const t of tokens) {
          if (byName.has(t.name)) continue;
          try { const s = await getSkillFull(t.name); if (s && s.content) byName.set(t.name, s); } catch { /* 未知技能跳过 */ }
        }
        if (byName.size > 0) {
          // 需求 = 原文剥除命中的 /词(同一技能多次出现也一并剥除);
          // 只清理词边界空白,段内换行等排版保留
          const segs = [];
          let pos = 0;
          for (const t of tokens) {
            if (!byName.has(t.name)) continue;
            segs.push(rawText.slice(pos, t.start).trim());
            pos = t.end;
          }
          segs.push(rawText.slice(pos).trim());
          const need = segs.filter(Boolean).join(' ');
          const injected = [...byName.values()];
          // 展开详情用:从目录补描述,正文取前 600 字作预览(完整内容模型已收到,前端只做展示)
          const cat = getSkillsCatalog();
          injectedSkills = injected.map((s) => ({
            name: s.name,
            description: (cat.find((c) => c.name === s.name) || {}).description || '',
            preview: String(s.content || '').slice(0, 600)
          }));
          const blocks = injected.map((s) => `【技能 ${s.name} 指令,请严格遵循】\n\n${s.content}`).join('\n\n————\n\n');
          text = need
            ? `【用户请求使用 ${injected.length} 个技能完成以下需求。以下为各技能指令,请严格遵循:】\n\n${blocks}\n\n————\n用户需求:\n${need}`
            : `【用户请求使用 ${injected.length} 个技能。以下为各技能指令,请严格遵循并按其行动:】\n\n${blocks}`;
        }
      }
    }

    // 会话尚无用户消息时,用首条指令自动命名该会话(便于在会话列表里识别)
    if (runSessionId && !session.hasUserMessages()) {
      // 用原始 /技能 需求 文本命名,避免注入后的整段指令污染标题;纯附件消息用附件摘要命名
      const t = (rawText || (atts.length ? `发送了 ${atts.length} 个附件` : '')).replace(/\s+/g, ' ').slice(0, 24);
      if (t) sessions.rename(runSessionId, t);
    }

    // 附件 -> 模型可见文本:小文本文件内联全文,其他文件给路径说明。
    // 图片不加正文(多模态模型在请求期注入 image_url;不支持视觉的模型在下面补说明)
    const imageAtts = atts.filter((a) => a.kind === 'image');
    let attBlocks = await attachmentTextBlocks(atts);
    if (imageAtts.length > 0) {
      // 图片附件 id 必须显式告诉模型:模型看不到 id 就无法把它转交给 generate_image 工具。
      // 非多模态模型尤其关键——它的字节不会被注入(注入会直接让上游报错),
      // 但"图生图"仍然要成立:模型只需拿着 id 调工具,参考图由服务端读盘送给图像端点。
      attBlocks += (attBlocks ? '\n\n' : '\n\n') + imageAtts
        .map((a) => allowVision
          ? `【图片附件:${a.name}(${fmtSize(a.size)}),附件 id=${a.id}——已随本消息提供视觉内容;需要以它为参考生图时,把该 id 传给 generate_image 的 reference_attachment_ids。】`
          : `【图片附件:${a.name}(${fmtSize(a.size)}),附件 id=${a.id}——当前模型未开启多模态,你看不到图片内容;`
          + `但 generate_image 工具能读取它。用户若要求"按这张图/参考这张图/改这张图"生图,`
          + `请把该 id 原样放进 reference_attachment_ids 调用工具,不要因此拒绝用户。】`)
        .join('\n');
    }
    if (attBlocks) text = String(text || '') + attBlocks;

    const turnStartSeq = session.seq;
    const turn = session.nextTurn();
    rt.overflowRecoveries = 0; // 新一轮:爆窗恢复次数清零
    let turnOpened = false;
    let useTools = !this._chatOnly;
    let finalText = '';
    let reasoningChars = 0; // 本轮累计收到的思考字符(供 turn 结束的"零思考"提示判断)
    let stepsUsed = 0;
    let endReason: { kind: string; error?: any } = { kind: 'completed' };
    let stepPartial = '';         // 当前步已流式收到的正文(中止时抢救落盘,保住"正在回答的部分")
    let stepPartialReasoning = '';

    // start 事件只展示原始输入(/技能1 /技能2 需求),日志里才写注入后的完整指令,避免刷屏;
    // 附件元数据随事件下发,前端在用户气泡内渲染缩略图/文件 chip
    const displayText = rawText;
    this.emit('agent', {
      event: 'start', text: displayText, sid: runSessionId,
      ...(atts.length ? { attachments: atts } : {})
    });
    // 手动调用技能(输入中的 /技能名 命中)会注入正文;单独发一个标记事件,
    // 前端据此展示"已加载技能"折叠行(模型主动调用则走 skill 工具,另行显示 tool_call 卡片)
    if (injectedSkills.length > 0) {
      this.emit('agent', { event: 'skill_loaded', skills: injectedSkills, sid: runSessionId });
    }
    try {
      // 技能目录:每轮开始按需刷新一次(工作区变化或 TTL 过期),供 system prompt 注入
      if (useTools && skillsCatalogStale()) {
        try { await refreshSkillsCatalog(); } catch { /* 扫描失败不阻塞本轮 */ }
      }
      // 工具调用上下文:todo_write 等需要写会话事件日志的工具从这里拿到所属会话
      const invokeCtx = { sid: runSessionId, session, emit: this.emit };
      // 对齐 harness agent-loop:轮内步数没有上限,循环由"模型不再发起工具调用"自然收敛;
      // 上下文水位由压缩治理,失控时用户可随时手动停止。
      for (let step = 1; ; step++) {
        if (signal.signal.aborted) throw new Error('已停止');
        if (!turnOpened) {
          session.append('turn/start', { turn }); turnOpened = true;
          // 新一轮(新用户请求)重置重复调用计数,避免跨轮误报
          rt.lastCallKey = null; rt.lastCallCount = 0;
        }
        session.append('step/start', { turn, step });
        if (step === 1) session.append('user/message', {
          // content=注入后的完整指令(模型历史从它投影,技能必须可见);
          // display=用户原文(前端渲染用,避免历史回放时把技能指令当作用户消息刷屏,对齐 harness)
          content: text, display: rawText, source: 'user',
          // 附件元数据随事件持久化:前端历史回放渲染缩略图,请求期多模态注入 image_url
          ...(atts.length > 0 ? { attachments: atts } : {}),
          // 注入的技能详情随事件持久化,历史回放/分支时前端可恢复"已加载技能"折叠行
          ...(injectedSkills.length > 0 ? { skillsInjected: injectedSkills } : {})
        });

        // 收件箱:领取运行中注入(steer),作为本步的追加 user 消息;
        // 真实用户输入到达时重置 repeat-tool-reminder 计数(对齐 harness guard 的 reset 语义)
        for (const s of rt.steer.splice(0)) {
          session.append('user/message', {
            content: s.text, source: 'steer',
            ...(Array.isArray(s.attachments) && s.attachments.length ? { attachments: s.attachments } : {})
          });
          if (!s.internal) { rt.lastCallKey = null; rt.lastCallCount = 0; }
        }

        // 运行时上下文快照(对齐 harness runtime-context 投影):工作区/技能目录/环境探测
        // 等动态信息不进 system prompt,而是作为 user 消息进入历史;文本变化才追加新快照。
        // system 因此保持逐字节稳定,提供方/网关的前缀缓存不会中途失效。
        const contextText = this._buildRuntimeContext(this.getPermissionMode(runSessionId));
        if (contextText !== rt.lastContextText) {
          session.append('user/message', { content: contextText, source: 'runtime', display: '⚙ 运行时上下文已更新' });
          rt.lastContextText = contextText;
        }

        stepsUsed = step;
        this.emit('agent', { event: 'iteration', iter: step, sid: runSessionId });

        // 模型请求 = system(静态提示词) + 事件日志投影出的派生历史 + 全量工具 schema。
        // 治理顺序(对齐 harness compactIfNeeded):测量口径 = surface 消息 + 固定信封
        // (system + 工具 schema);超过窗口 80% 水位时先跑无模型裁剪(pruner 折叠大工具
        // 结果),仍超再做摘要压缩;窗口未配置时由字符预算兜底裁剪承担最后防线
        // (差异:harness 总能拿到模型窗口,本工具需兼容窗口未配置的提供方)。
        const systemText = this._systemPrompt(reasoning);
        const ctxWindow = (this.llm && this.llm.contextWindow) || 0;
        const toolSchemas = useTools ? registry.schemas({ localOnly: !ssh.connected }) : [];
        // 每次请求的固定开销(system 提示词 + 工具 schema)估算:压缩水位按"整次请求"计量,
        // 只量历史会让触发点比真实水位晚一个信封的体量(实测偏差可达数万 token)。
        const reservedTokens = estimateTokens(systemText) + (toolSchemas.length ? estimateTokens(JSON.stringify(toolSchemas)) : 0);
        // 先用完整历史投影(不裁剪);折叠/压缩/裁剪都发生在投影副本上,
        // trace 与消息一一对应,供压缩落盘时把消息下标映射回事件 seq。
        let trace = session.deriveMessagesWithTrace({ budgetChars: Infinity });
        let historyMsgs = trace.map((t) => t.msg);
        // 绝对地板(补回):声明窗口虚高(前端兜底 1M)或未配置时,compactHistory 的 80%
        // 水位永不触发,单轮深工具会话会无治理增长(实测冲到 100k+ token)。这里在每次
        // 请求前按"预估请求 token(历史 + system + 工具 schema)"查地板,超过就先做一轮
        // 保最近的投影折叠(日志不动,只裁模型当轮可见面),与水位裁剪互补。
        const P = AGENT.TOOL_RESULT_PRUNE;
        if (P.ABS_FLOOR_TOKENS > 0 && measureMessages(historyMsgs) + reservedTokens > P.ABS_FLOOR_TOKENS) {
          const r = pruneToolResults(historyMsgs, {
            keepRecent: P.ABS_FLOOR_KEEP_RECENT, minChars: P.ABS_FLOOR_THRESHOLD_CHARS, headChars: P.HEAD_CHARS, tailChars: P.TAIL_CHARS
          });
          if (r.pruned > 0) {
            historyMsgs = r.messages;
            console.log(`[agent] 历史工具结果折叠:${r.pruned} 条(预估请求 ${Math.round(measureMessages(historyMsgs) + reservedTokens + r.charsSaved)} token 超绝对地板 ${P.ABS_FLOOR_TOKENS}),省约 ${r.charsSaved} 字符`);
          }
        }
        if (ctxWindow > 0 && historyMsgs.length > 2) {
          const c = await compactHistory({
            messages: historyMsgs, system: systemText, llm: this.llm, signal: signal.signal,
            contextWindow: ctxWindow, maxTokens: this.llm.maxTokens, reservedTokens
          });
          if (c.compacted) {
            const dropSeqs = trace.slice(0, c.dropCount).map((t) => t.seq);
            // 非破坏压缩:早期消息完整保留在日志里,只追加检查点;模型历史投影自检查点起
            // 以摘要顶替被压消息(front 端显示完整,刷新后可回看全部早期对话)。
            session.markCompacted(dropSeqs, c.messages[0].content, { dropCount: c.dropCount, manual: false });
            // 重新投影,保证后续爆窗恢复的事件 seq 映射仍然有效
            trace = session.deriveMessagesWithTrace({ budgetChars: Infinity });
            historyMsgs = trace.map((t) => t.msg);
            console.log(`[agent] 上下文超水位,已自动压缩早期 ${c.dropCount} 条消息${c.pruned ? `(此前折叠 ${c.pruned} 条大工具结果)` : ''}(窗口 ${ctxWindow})`);
            // 广播压缩标记行事件:前端在消息流里插入「上下文压缩」披露行(运行中不做整表
            // 重拉,避免打断正在流式的输出);压缩摘要由 compaction/done 事件随历史重放。
            this.emit('agent', {
              event: 'compaction_done', sid: runSessionId,
              dropCount: c.dropCount, manual: false, summary: c.messages[0].content
            });
          } else if (c.pruned > 0) {
            historyMsgs = c.messages; // pruner 折叠生效(只裁模型当轮可见面,日志不动)
            console.log(`[agent] 上下文超水位,已折叠 ${c.pruned} 条大工具结果(未触发摘要压缩,窗口 ${ctxWindow})`);
          }
        }
        // 兜底字符裁剪:窗口未配置/摘要未触发时按预算裁剪,但永不丢原始任务锚点。
        historyMsgs = trimMessagesByBudget(historyMsgs, resolveCharBudget(ctxWindow));
        const messages = [{ role: 'system', content: systemText }, ...historyMsgs];
        // 多模态注入:模型声明了视觉能力时,把带图片附件的 user 消息升级为
        // content 数组(文本 + image_url);测量/压缩仍走元数据口径的 messages
        const wireMessages = allowVision ? await materializeImageParts(messages) : messages;

        let res;
        try {
          stepPartial = '';
          stepPartialReasoning = '';
          rt.live = null; // 新一步开始:上一半成品已随 assistant/message 落盘(或被回滚),清掉投影缓冲
          res = await this.llm.chat({
            messages: wireMessages,
            tools: toolSchemas,
            signal: signal.signal,
            reasoning,
            onDelta: (d) => {
              if (d.kind === 'text') {
                stepPartial += d.text;
                this.emit('agent', { event: 'text_delta', text: d.text, sid: runSessionId });
              } else if (d.kind === 'reasoning') {
                stepPartialReasoning += d.text;
                this.emit('agent', { event: 'reasoning_delta', text: d.text, sid: runSessionId });
              }
              // 镜像进 runtime:get_history 需要投影"正在生成、尚未落盘"的部分内容,
              // 否则切回运行中会话时前端整表替换会丢掉已流出的回复(见 getHistory)
              rt.live = { content: stepPartial, reasoning: stepPartialReasoning };
            },
            // 请求失败进入重试:把「重试第几次」推给前端显示(对齐 harness llm-retry 的 retry 事件语义)
            onRetry: (r) => {
              this.emit('agent', { event: 'retry', ...r, sid: runSessionId });
            }
          });
        } catch (e) {
          // 上下文爆窗恢复(对齐 harness agent/request-error + compactIfNeeded 的
          // context-overflow 分支):强力折叠(最近 0 条保留)+ 最大力度摘要压缩
          // (retainTokensOverride=0,只留最后一个配对完整节点)后重试本步,
          // 最多 MAX_OVERFLOW_RECOVERIES 次。只在请求还没流出任何内容时恢复,
          // 避免把已展示的增量重复一遍(爆窗 400 发生在流建立之前,天然满足)。
          if (isContextOverflowError(e) && ctxWindow > 0 && this.llm && !signal.signal.aborted
            && rt.overflowRecoveries < AGENT.MAX_OVERFLOW_RECOVERIES
            && !stepPartial && !stepPartialReasoning) {
            rt.overflowRecoveries++;
            const llm = this.llm;
            this.emit('agent', {
              event: 'notice', sid: runSessionId,
              text: `请求超出模型上下文窗口,已自动折叠并压缩历史后重试(第 ${rt.overflowRecoveries} 次)。原始错误: ${String((e as any)?.message || e).slice(0, 160)}`
            });
            const P = AGENT.TOOL_RESULT_PRUNE;
            historyMsgs = pruneToolResults(historyMsgs, {
              keepRecent: 0, minChars: P.THRESHOLD_CHARS, headChars: P.HEAD_CHARS, tailChars: P.TAIL_CHARS
            }).messages;
            const c = await compactHistory({
              messages: historyMsgs, system: systemText, llm, signal: signal.signal,
              contextWindow: ctxWindow, maxTokens: llm.maxTokens, reservedTokens,
              force: true, retainTokensOverride: 0
            });
            if (c.compacted) {
              const dropSeqs = trace.slice(0, c.dropCount).map((t: any) => t.seq);
              // 非破坏压缩(同常规自动压缩):日志完整保留,只追加检查点
              session.markCompacted(dropSeqs, c.messages[0].content, { dropCount: c.dropCount, manual: false });
              historyMsgs = c.messages;
              console.log(`[agent] 爆窗恢复:已折叠并压缩早期 ${c.dropCount} 条消息后重试本步`);
              this.emit('agent', {
                event: 'compaction_done', sid: runSessionId,
                dropCount: c.dropCount, manual: false, summary: c.messages[0].content
              });
            }
            step--; // 重试本步(for 循环 step++ 会把它加回原值)
            continue;
          }
          // 模型/上游不支持工具调用(如推理模型):回滚本轮已写事件,降级为纯对话重开。
          // 这是配置级失败而非对话事实,清掉重试比把失败轮留在历史里更干净。
          if (useTools && step === 1 && !signal.signal.aborted && isToolUnsupportedError(e)) {
            const raw = String(e.message || e).slice(0, 300);
            this._chatOnlyUntil = Date.now() + AGENT.CHAT_ONLY_TTL_MS; // 带 TTL 降级,超时自动重试工具
            useTools = false;
            session.truncate(turnStartSeq);
            turnOpened = false;
            // 原始错误必须可见:可能是模型真不支持,也可能是网关渠道问题,由用户判断
            this.emit('log', 'warn', `[agent] 工具调用被上游拒绝,已降级为纯对话。原始错误: ${raw}`);
            this.emit('agent', {
              event: 'notice', sid: runSessionId,
              text: `当前模型/上游拒绝了工具调用,已自动降级为纯对话模式(无法在远程读写文件/执行命令)。若是网关临时故障,稍后重开一个会话即可恢复;若是模型确实不支持(如推理模型),请换模型。原始错误: ${raw}`
            });
            step = 0; // 重开本轮(下一循环从 step=1 重新开始)
            continue;
          }
          throw e;
        }

        // 累计本轮收到的思考字符
        reasoningChars += (res.reasoning || '').length;

        // 上下文用量广播:estimated = 本次实际发送请求(含 system,折叠后)的启发式估算,
        // actual = 提供方上报的真实 prompt_tokens(网关不报则为 null)。
        // 前端仪表盘改为显示这个口径,不再按"渲染历史"估算——两个口径可差几十万 token。
        const reqTokens = measureMessages(messages);
        const usage = res.usage || null;
        this.emit('agent', {
          event: 'context_usage', sid: runSessionId,
          estimated: reqTokens,
          actual: usage && typeof usage.promptTokens === 'number' ? usage.promptTokens : null,
          output: usage && typeof usage.completionTokens === 'number' ? usage.completionTokens : null,
          window: ctxWindow || 0
        });
        console.log(`[agent] 请求 ${(this.llm && this.llm.model) || ''}:预估输入 ${Math.round(reqTokens)}${usage && typeof usage.promptTokens === 'number' ? ` / 实际 ${usage.promptTokens}` : ''}${usage && typeof usage.completionTokens === 'number' ? ` / 输出 ${usage.completionTokens}` : ''} token(窗口 ${ctxWindow || '未配置'})`);

        // 记录本步 assistant 消息(工具调用参数需以 JSON 字符串回传;
        // DeepSeek v4 思考模式下,reasoning_content 必须随历史原样回传,否则 400)
        const assistantMsg = {
          role: 'assistant',
          content: res.content || '',
          tool_calls: (res.toolCalls || []).map((t) => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) }
          })),
          ...(res.reasoning ? { reasoning_content: res.reasoning } : {})
        };
        session.append('assistant/message', { turn, step, message: assistantMsg });
        // 该步完整落盘,部分内容缓冲区清空:之后一旦中止(如工具执行期间),不会重复抢救
        stepPartial = '';
        stepPartialReasoning = '';
        rt.live = null; // 已落盘:get_history 从事件日志投影,不再需要 live 半成品(防重复投影)

        // 停止条件(对齐 harness agent-loop step()):模型不再发起工具调用即本轮结束(completed)。
        // 输出因 max_tokens 被截断时同样结束,结束原因记为 max-tokens(harness 的粘性语义:
        // 截断的步骤不得被当作正常完成),是否继续由用户决定,而不是宿主替模型续跑。
        if (!res.toolCalls || res.toolCalls.length === 0) {
          finalText = res.content || '';
          session.append('step/end', { turn, step });
          if (String(res.finishReason || '').toLowerCase() === 'length') {
            endReason = { kind: 'max-tokens' };
            this.emit('agent', { event: 'notice', sid: runSessionId, text: '上一条回复因达到输出上限被截断,本轮已结束;发送"继续"可让模型接着输出。' });
          }
          break;
        }

        // 执行本步全部工具调用(并发安全判定 + 有界滚动池见 _runToolCalls:
        // 并发发起、结果按模型请求顺序提交)。
        const { turnConcluded } = await this._runToolCalls(rt, session, runSessionId, signal, turn, step, res.toolCalls, invokeCtx);

        session.append('step/end', { turn, step });
        if (turnConcluded) break; // 工具显式收尾:本轮到此为止,不再请求模型
      }

      this.emit('agent', { event: 'done', text: finalText, iters: stepsUsed, sid: runSessionId });

      // 请求了思考但整轮颗粒无收:当前模型经该网关不输出思考流(部分中转如此,
      // 实测如 deepseek-v4-flash-0731 经 tokenrhythm/cun)。正文与工具调用不受影响;
      // 明说一次,免得用户误以为前端把思考弄丢了。
      if (reasoning !== 'off' && reasoningChars === 0 && this.llm && !this.llm.isMock
        && /^(deepseek-v4|glm-|qwen)/i.test(this.llm.model || '')) {
        this.emit('agent', {
          event: 'notice', sid: runSessionId,
          text: `本轮未收到思考内容:模型 ${this.llm.model} 经当前网关未返回思考流(正文与工具调用不受影响)。如需查看每步思考,请切换到已验证会返回思考的模型(如 deepseek-v4-pro、glm-5.3)。`
        });
      }
    } catch (e) {
      if (signal.signal.aborted) {
        endReason = { kind: 'aborted' };
        // 抢救正在生成的部分内容:模型回复流被中断时 assistant/message 尚未落盘,
        // 把已流式收到的正文补成一条残缺消息,切换/断开后回来仍能看到生成到哪了
        if (stepPartial || stepPartialReasoning) {
          session.append('assistant/message', {
            turn, step: stepsUsed,
            message: {
              role: 'assistant',
              // 半成品消息不再附加"生成被中断"标记(用户反馈无需提示);
              // 保留已生成正文,切换/断开后回来仍能看到生成到哪了
              content: stepPartial
                + (stepPartial && !stepPartial.endsWith('\n') ? '\n' : ''),
              ...(stepPartialReasoning ? { reasoning_content: stepPartialReasoning } : {})
            }
          });
        }
        this.emit('agent', { event: 'stopped', sid: runSessionId });
      } else {
        endReason = { kind: 'error', error: String(e.message || e) };
        this.emit('log', 'error', `Agent 错误: ${e.message}`);
        this.emit('agent', { event: 'error', message: e.message, sid: runSessionId });
      }
    } finally {
      rt.live = null; // 本轮收尾(含中止抢救:半成品已落成真实 assistant/message):live 投影缓冲必须清空
      // 自愈:给中止时未闭合的工具调用补结果,保证日志重放出的消息序列永远合法
      for (const c of session.pendingToolCalls()) {
        session.append('tool/result', {
          turn: c.turn, step: c.step, callId: c.callId, name: c.name,
          isError: true, content: '工具执行中止(本轮已停止)', ms: 0
        });
      }
      session.append('turn/end', { turn, reason: endReason });
      // 本轮结束仍未消费的注入转入下一轮输入(非中止时),不丢用户消息;
      // 系统内部提醒(internal,如重复调用提醒)不跨轮转成用户输入
      if (endReason.kind !== 'aborted') {
        for (const s of rt.steer.splice(0)) {
          if (s && s.internal) continue;
          rt.inbox.push(s);
        }
      }
      if (runSessionId) {
        sessions.saveEvents(runSessionId, session.events); // 落盘,重启后可恢复
        this.emit('agent', { event: 'sessions_changed' }); // 后台会话结束也刷新前端会话列表
      }
    }
    // 把本轮收尾原因返回给 driver:正常结束(completed/error)时待执行队列自动续跑,
    // 中止(aborted)时保留排队项等下次对话
    return endReason;
  }

  /**
   * 生图模型的一轮(imageGen 旁路):一轮 = 一次 /images/* 请求 = 一张成图。
   * 路由规则(图像端点只接受单个 prompt 字符串、不吃消息历史,所以"多轮"靠携带参考图实现):
   *  - 本轮上传了图片        → /images/edits + 上传的图(多张一起送,上游逐张消费)
   *  - 会话内已有上一张成图  → /images/edits + 自动携带该成图(等价于"把刚才那张改一下")
   *  - 两者都没有            → /images/generations(文生图)
   * 与文本轮的三处关键差异:不自动重试(按张计费,重试=重复扣费)、不注入 system/工具、
   * 不做上下文压缩(没有消息历史可压)。
   */
  async _runImageTurn(rt: any, runSessionId: string | null, { text, attachments }: { text: string; attachments: AttachmentMeta[] }): Promise<{ kind: string; error?: any }> {
    const llm = this.llm;
    if (!llm) throw new Error('尚未配置 LLM(设置 -> 模型配置)');
    const session: Session = rt.session;
    const signal: AbortController = rt.signal;
    const rawText = String(text || '').trim();
    const atts: AttachmentMeta[] = Array.isArray(attachments) ? attachments : [];
    const uploads = atts.filter((a) => a.kind === 'image');
    const files = atts.filter((a) => a.kind !== 'image');
    const prev = lastGeneratedImage(session.events);
    const isFirst = !session.hasUserMessages();
    const turn = session.nextTurn();
    let endReason: { kind: string; error?: any } = { kind: 'completed' };
    let turnOpened = false;

    // start 事件与文本轮共用:前端据此渲染用户气泡 + 一条流式中的 assistant 气泡,
    // 并推进分支点计数(生图轮同样占两个 turn:用户消息 + 成图消息)
    this.emit('agent', {
      event: 'start', text: rawText, sid: runSessionId,
      ...(atts.length ? { attachments: atts } : {})
    });
    try {
      if (isFirst && runSessionId) {
        const t = (rawText || (uploads.length ? `发送了 ${uploads.length} 张图片` : '')).replace(/\s+/g, ' ').slice(0, 24);
        if (t) sessions.rename(runSessionId, t);
      }
      session.append('turn/start', { turn }); turnOpened = true;
      session.append('step/start', { turn, step: 1 });
      // 原文即提示词,不做技能注入/附件正文合成:日志里存的就是用户说的话
      session.append('user/message', {
        content: rawText, source: 'user',
        ...(atts.length ? { attachments: atts } : {})
      });
      if (signal.signal.aborted) throw new Error('已停止');
      if (files.length) {
        this.emit('agent', {
          event: 'notice', sid: runSessionId,
          text: `生图模型只能接受图片参考,本轮 ${files.length} 个文件附件未使用(${files.map((f) => f.name).join('、')})。`
        });
      }
      // 图像端点 prompt 必填(空串上游 400):纯图无文字时给一个通用创作指令
      const prompt = rawText || (uploads.length || prev ? '请参考图片进行创作,保持主体与整体构图。' : '请生成一张高质量图片。');
      // 上传优先:用户这一轮主动给的图就是他要的参考;没给才回落到上一张成图做迭代修改
      this.emit('agent', {
        event: 'image_job', sid: runSessionId,
        mode: uploads.length || prev ? 'i2i' : 't2i', refs: uploads.length || (prev ? 1 : 0), prompt
      });
      const job = await runImageJob({
        llm, prompt,
        refIds: uploads.map((a) => a.id),
        useLastImage: uploads.length === 0,
        events: session.events,
        signal: signal.signal
      });
      if (signal.signal.aborted) throw new Error('已停止');
      if (job.skipped.length) {
        this.emit('agent', {
          event: 'notice', sid: runSessionId,
          text: `${job.skipped.length} 张参考图不可用(附件已清理或不是图片),已跳过。`
        });
      }

      // 成图落盘为附件由 runImageJob 统一完成:字节进附件库、日志只存元数据(与用户上传
      // 同规则)。这是"多轮迭代"能成立的前提——下一轮要靠这个 id 把成图读回来当参考图。
      const ms = job.ms;
      const caption = imageCaption({ mode: job.mode, refs: job.refs, size: job.size, count: job.saved.length });
      // assistant/message 让切回文本模型时 AI 仍知道这里出过图;image/generated 承载成图元数据
      session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: caption } });
      session.append('image/generated', {
        turn, step: 1, mode: job.mode, prompt: job.prompt,
        attachments: job.saved, refs: job.refs,
        size: job.size, upstreamModel: job.upstreamModel, ms
      });
      rt.live = null;
      session.append('step/end', { turn, step: 1 });
      this.emit('agent', {
        event: 'image_done', sid: runSessionId, mode: job.mode, refs: job.refs, ms,
        size: job.size || null, revised: job.revisedPrompt || null,
        attachments: job.saved
      });
      this.emit('agent', { event: 'done', text: caption, iters: 1, sid: runSessionId });
      console.log(`[agent] 生图 ${job.mode} 完成:${job.saved.length} 张,耗时 ${Math.round(ms / 1000)}s,上游尺寸 ${job.size || '未知'}`);
    } catch (e: any) {
      if (signal.signal.aborted) {
        endReason = { kind: 'aborted' };
        this.emit('agent', { event: 'stopped', sid: runSessionId });
      } else {
        endReason = { kind: 'error', error: String(e?.message || e) };
        this.emit('log', 'error', `生图错误: ${e?.message || e}`);
        this.emit('agent', { event: 'error', message: e?.message || String(e), sid: runSessionId });
      }
    } finally {
      rt.live = null;
      if (turnOpened) session.append('turn/end', { turn, reason: endReason });
      if (runSessionId) {
        sessions.saveEvents(runSessionId, session.events);
        this.emit('agent', { event: 'sessions_changed' });
      }
    }
    return endReason;
  }

  /**
   * 执行一步内的全部工具调用。
   * - 串行模式(AGENT.CONCURRENT_TOOL_CALLS=false 或并发上限=1):逐条执行,保持
   *   "结果紧跟对应调用"的原始语义。
   * - 并行模式( agent-loop 的 runGroup):有界滚动池并发启动
   *   至多 MAX_PARALLEL_TOOL_CALLS 个调用,结果按模型请求顺序(tool_calls 顺序)
   *   提交,保证 tool/result 与 assistant 消息严格配对、历史可回放。
   * - 中止:停止启动新调用,排干已启动调用(registry.execute 对中止返回结构化错误),
   *   已产生的结果仍按序提交,随后抛 '已停止' 交由外层按 aborted 收尾;未启动的
   *   调用不产生 tool/call 事件(与串行路径一致,由 finally 自愈兜底)。
   */
  async _runToolCalls(rt: any, session: Session, runSessionId: string | null, signal: AbortController, turn: number, step: number, toolCalls: any[], invokeCtx: any): Promise<{ turnConcluded: boolean }> {
    const calls = toolCalls.map((tc: any) => {
      const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
      let pretty = rawArgs;
      try { pretty = JSON.stringify(JSON.parse(rawArgs), null, 2); } catch {}
      return { tc, rawArgs, pretty };
    });
    const maxParallel = AGENT.CONCURRENT_TOOL_CALLS ? Math.max(1, AGENT.MAX_PARALLEL_TOOL_CALLS || 1) : 1;

    // 结果槽位:只有连续(按模型顺序)槽位就绪才落盘,保证并发完成也不乱序
    const slots: Array<ToolResult | undefined> = new Array(calls.length).fill(undefined);
    const inFlight = new Map<number, Promise<void>>();
    let nextToStart = 0;
    let committed = 0;
    let turnConcluded = false;

    // 并发安全互斥(对齐 harness tool-calls 的 executionMode):isConcurrencySafe=true 的调用
    // 之间才并行;不安全(mutating 写文件/编辑/删除、交互等待等)的调用必须独占执行——
    // 与其它任何调用并发都可能产生 read-modify-write 竞态(如两条 edit_file 同文件,
    // 后读的一方会把先写的一方的更新覆盖掉)。未知/判定异常一律按不安全处理(fail-closed)。
    // 调用发起顺序仍严格保持模型顺序(只是相互等待),结果提交顺序语义不变。
    const safeFlags = calls.map((c) => registry.isConcurrencySafe(c.tc.name));
    const barrierBlocks = (index: number) => {
      if (inFlight.size === 0) return false;
      if (!safeFlags[index]) return true; // 自身不安全:等在飞的全部排干(独占执行)
      return [...inFlight.keys()].some((j) => !safeFlags[j]); // 有不安全调用在飞:其余也得等它落地
    };

    const commitReady = () => {
      while (committed < calls.length) {
        const slot = slots[committed];
        if (!slot) break; // 前序(模型顺序更靠前)的调用还没完成,等它
        this._emitToolResult(session, runSessionId, turn, step, calls[committed].tc, slot);
        if (slot.concludesTurn) turnConcluded = true; // 工具显式宣告本轮结束(harness concludesTurn)
        committed++;
      }
    };

    const startCall = async (index: number) => {
      const { tc, rawArgs, pretty } = calls[index];
      if (signal.signal.aborted) throw new Error('已停止');
      this.emit('agent', { event: 'tool_call', tool: tc.name, args: pretty, callId: tc.id, sid: runSessionId });
      session.append('tool/call', { turn, step, callId: tc.id, name: tc.name, arguments: rawArgs });
      this._toolRepeatReminder(rt, tc.name, rawArgs);
      slots[index] = await registry.execute({ name: tc.name, args: rawArgs, signal: signal.signal, invokeCtx });
    };

    const fillPool = async () => {
      while (!signal.signal.aborted && nextToStart < calls.length && inFlight.size < maxParallel && !barrierBlocks(nextToStart)) {
        const index = nextToStart++;
        const promise = startCall(index).then(
          () => { inFlight.delete(index); },
          (e) => { inFlight.delete(index); throw e; }
        );
        inFlight.set(index, promise);
        commitReady(); // 已立即完成(同步/极快)的调用按序落盘,避免占用池位
      }
    };

    try {
      await fillPool();
      while (inFlight.size > 0) {
        await Promise.race(inFlight.values()); // 任一调用完成即腾出池位并继续补充
        commitReady();
        await fillPool();
      }
      commitReady();
    } catch (e) {
      // 调度/启动异常(如中止):排干已启动调用,已产生的结果仍按序提交,再重抛
      await Promise.allSettled([...inFlight.values()]);
      commitReady();
      throw e;
    }

    if (signal.signal.aborted) throw new Error('已停止');
    return { turnConcluded };
  }

  /** 提交单个工具结果:落盘 tool/result + 向前端发 tool_result(与工具执行解耦,供并行按序调用) */
  _emitToolResult(session: Session, runSessionId: string | null, turn: number, step: number, tc: any, r: ToolResult) {
    // 结果全量入日志(体量上限由工具层输出 cap 与注册表 spill 策略保证);
    // 早期大结果由压缩水位的 pruner 折叠(harness 语义),不再在落盘时截断。
    session.append('tool/result', {
      turn, step, callId: tc.id, name: tc.name,
      isError: r.isError, content: r.content, ms: r.ms,
      ...(r.meta !== undefined ? { meta: r.meta } : {}) // 结构化 UI 数据(终端卡 exitCode/cwd 等)
    });
    const short = r.content.length > 4000 ? r.content.slice(0, 4000) + `\n…[结果较多,已折叠展示 ${r.content.length} 字符]…` : r.content;
    this.emit('agent', {
      event: 'tool_result', tool: tc.name, ok: !r.isError, ms: r.ms, result: short, callId: tc.id, sid: runSessionId,
      ...(r.meta !== undefined ? { meta: r.meta } : {})
    });
  }

  // repeat-tool-reminder(移植 harness guard):连续相同工具+参数调用达到阈值时,
  // 在下一步注入提醒,防模型原地打转(advisory,不拦截调用)。调用按模型顺序发起,故判定顺序不变。
  _toolRepeatReminder(rt: any, name: string, rawArgs: string) {
    const canonicalKey = JSON.stringify([name, canonicalizeArgs(rawArgs)]);
    rt.lastCallCount = rt.lastCallKey === canonicalKey ? rt.lastCallCount + 1 : 1;
    rt.lastCallKey = canonicalKey;
    if (AGENT.REPEAT_REMIND_THRESHOLDS.includes(rt.lastCallCount)) {
      const preview = previewArgs(rawArgs, AGENT.REPEAT_ARG_PREVIEW);
      rt.steer.unshift({
        text: `你已连续 ${rt.lastCallCount} 次以相同参数调用 ${name}${preview ? `(参数: ${preview})` : ''}。请分析上次结果、换参数或换方法;若已收集足够证据,直接用 todo_write 收尾并结束。`,
        reasoning: 'default',
        internal: true // 系统内部提醒:不会跨轮转成用户输入(见 _runTurnInner finally)
      });
    }
  }

  /**
   * 运行时上下文快照(对齐 harness 的 runtime-context / system-prompt context 注册项):
   * 工作区、平台、技能目录与最近一次环境探测结果拼成一段文本,由调用方在 pre-step
   * 作为 user 消息追加进历史——文本与上次不同才追加(变化才发,新快照取代旧快照)。
   * 环境段带字符预算(AGENT.ENV_SNAPSHOT_MAX_CHARS),目录树再大也不允许撑爆历史。
   */
  _buildRuntimeContext(mode: PermissionMode = DEFAULT_PERMISSION_MODE): string {
    const localMode = !ssh.connected;
    // 工作区一行的三种状态:绑定了目录 / 「不在工作区对话」(全盘模式) / 未设置
    const WHOLE_REMOTE = `未选择工作区·「不在工作区对话」:边界=整台远程服务器文件系统(根 /),`
      + `所有文件工具必须传绝对路径(如 /etc/hosts),相对路径会被拒绝;命令未 cd 时默认在家目录执行`;
    const WHOLE_LOCAL = `未选择本地工作区·「不在工作区对话」:边界=整台电脑(${process.platform === 'win32' ? '所有盘符 C:\\、D:\\…' : '根目录 /'}),`
      + `所有文件工具必须传本机绝对路径(如 ${process.platform === 'win32' ? 'C:\\dir\\a.txt' : '/etc/hosts'} 或 ~/a.txt),相对路径会被拒绝`;
    const ws = ssh.workspace ? ssh.workspace : (ssh.noWorkspace ? WHOLE_REMOTE : '(未设置,请提示用户在界面中选择工作区)');
    const lws = localFs.workspace ? localFs.workspace : (localFs.noWorkspace ? WHOLE_LOCAL : '(未设置,请提示用户在界面中选择本地工作区)');
    const sections: string[] = [];
    // 权限模式说明(用户在输入框左下角切换):计划模式收紧为只读,确认/自动编辑下
    // 部分操作会先请求用户批准(拒绝时收到的工具结果会说明原因)
    sections.push(`权限模式: ${PERMISSION_MODE_META[mode].name} — ${PERMISSION_MODE_META[mode].description}${mode === 'plan' ? '。请把实施计划完整呈现给用户,不要尝试调用会被拒绝的工具。' : mode === 'confirm' ? '请求被拒绝时不要重试同一操作,调整方案或向用户说明影响。' : ''}`);
    // 工作区说明:本地模式下只讲本机工作区,不提"可操作远程"
    if (localMode) {
      sections.push(`本地平台: ${process.platform}`, `本地工作区: ${lws}`);
    } else {
      sections.push(`远程平台: ${ssh.platform || '未知'}`, `远程工作区: ${ws}`, `本地平台: ${process.platform}`, `本地工作区: ${lws}`);
    }
    // 技能目录(照搬 harness tool-skill 的 catalog 注入):有可用技能时提示模型按需加载
    const skillCatalog = renderSkillCatalog(getSkillsCatalog());
    if (skillCatalog) sections.push(skillCatalog);
    // 最近一次远程环境探测结果:让模型直接复用,避免每轮重复 get_workspace_info
    const env = getEnvInfo();
    if (env && env.workspace === ssh.workspace) {
      sections.push(`已知远程环境信息(来自最近一次探测,若无变化直接使用,无需重复调用 get_workspace_info):\n${String(env.summary || '').slice(0, AGENT.ENV_SNAPSHOT_MAX_CHARS)}`);
    }
    // 最近一次本地环境探测结果:让模型直接复用,避免每轮重复 get_local_info
    const lenv = getLocalEnvInfo();
    if (lenv && lenv.workspace === localFs.workspace) {
      sections.push(`已知本地环境信息(来自最近一次探测,若无变化直接使用,无需重复调用 get_local_info):\n${String(lenv.summary || '').slice(0, AGENT.ENV_SNAPSHOT_MAX_CHARS)}`);
    }
    return [
      '<runtime_context>',
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
      '(当前运行时上下文快照,取代此前所有快照;其中未变化的信息直接复用,不要重复探测)',
      '',
      ...sections,
      '</runtime_context>'
    ].join('\n');
  }

  _systemPrompt(reasoning = 'default') {
    // system 只保留静态内容:身份 + 工具指引 + 规则 + 用户自定义注入。
    // 动态信息(工作区/环境快照/技能目录)一律走 _buildRuntimeContext 的 user 快照消息,
    // 保证 system 逐字节稳定(harness 语义:system 不携带运行时状态,前缀缓存不失效)。
    // 推理等级:off 关闭思考(直答);xhigh/max 深度推理;其余按默认格式输出
    // off 档不再是"直接给结论"而是"直接行动":先调用工具完成任务后再给结论,避免模型只描述不执行
    const thinkingRule = reasoning === 'off'
      ? '11. 输出格式:直接行动——先调用所需工具完成任务后再给结论,不要只给结论不执行;不要输出 thinking 代码块,不要展示任何推理过程。'
      : (reasoning === 'xhigh' || reasoning === 'max')
        ? '11. 输出格式:先在 ```thinking(...```) 代码块中进行充分、系统的深度推理(允许较长,逐步分析再下结论),再在正文给出结论与操作;复杂任务务必先想清楚再动手。'
        : '11. 输出格式:任何推理过程请放在 ```thinking(...```) 代码块中(前端会折叠),不要污染正文;正文只给结论与操作。';
    // 工具选择规则:本地模式下远程工具已剔除,只提示用 *_local 工具
    const toolRule = !ssh.connected
      ? '2. 所有文件读写、命令执行一律用 `*_local` 工具(read_local_file/write_local_file/edit_local_file/run_local_command/list_local_dir/search_local_code/get_local_info/...),只在本机本地工作区操作;远程工具(read_file/write_file/run_command 等)当前不可用,不要调用。'
      : '2. 操作**远程**文件/命令用原工具(read_file/write_file/run_command/...);操作**本机**文件/命令用 `*_local` 工具(read_local_file/write_local_file/run_local_command/...)。不要在本地工具里传远程路径,反之亦然。';
    const lines = [
      'You are an AI agent powered by DeepSeek Harness.',
      '',
      'You are a coding agent. Your working directory is the current workspace.',
      'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.',
      'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first and prefer edit for targeted changes.',
      'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must be unique.',
      '',
      '规则:',
      '1. 所有文件读写、命令执行都必须通过工具完成,严禁编造内容或输出;看不到的结果就再查。',
      toolRule,
      '3. 命令默认在对应工作区目录下执行;若需切换目录,请在命令开头显式写 cd。',
      '4. 大文件用 read_file/read_local_file 的 offset/limit 按行分页(结果带行号,默认最多 2000 行);修改文件优先 edit_file/edit_local_file 精确替换。',
      '5. 写/改/删仅限对应工作区内;绝不能删除工作区根目录;破坏性命令(rm -rf、drop table 等)必须三思。',
      '6. 重要:<runtime_context> 快照与对话历史里已有的环境信息、目录结构和工具结果可直接复用,不要重复探测;只有任务涉及变化时才重新调用。',
      '7. 回答使用用户的提问语言(默认中文)。',
      '8. 任务规划(强制):复杂多步任务必须先调用 todo_write 建立完整计划(每项一个具体步骤),每完成一项立即标记 completed,允许且只允许一项 in_progress。任务计划全部 completed 之前,不得以文字回复代替执行——必须继续调用工具直到整张清单完成,或你已用工具验证整个目标确实达成。简单单步任务可跳过计划,但同样必须真正执行而不是只描述。',
      '9. 完成判定:宣称完成前,收集证据(读取文件、查看命令输出、检查修改结果)证明整个任务目标已达成,而不是只做了第一步就下结论。若发现遗漏或失败,继续修复直到证据确凿;无法推进时再调用 ask_user_question 或说明原因。',
      '10. 需要用户确认、选择或补充关键信息时,先调用 ask_user_question 向用户提问(可一次多道、带选项/多选/自定义),等用户作答后再继续,不要替用户做应由他决定的取舍;没有歧义时不要滥用。',
      thinkingRule,
      '',
      '当用户指令不明确、或工作区缺乏必要信息时,主动调用工具检查,而不是猜测。'
    ];
    // 全局指令注入(移植自 dsh-purge):用户自定义的 prompt-inject.md 作为强指令注入
    const inject = renderPromptInjectSection();
    if (inject) lines.push(inject);
    // 纯对话模式(模型不支持工具):明示能力边界,避免模型谎称已执行操作
    if (this._chatOnly) {
      lines.unshift(
        '注意:当前模型不支持工具调用(纯对话模式)。你无法实际读写远程文件或执行命令,',
        '也不要声称执行了任何操作;请基于已有信息给出文字回答,并提醒用户换支持工具的模型来获得完整能力。'
      );
    }
    return lines.join('\n');
  }
}

export const agent = new Agent({
  emit: (event, payload) => agentHub?.emit(event, payload)
});

// 由 ws 层注入
export let agentHub = null;
export function setAgentHub(h) { agentHub = h; }
