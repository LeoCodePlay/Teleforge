// 过程组的纯派生逻辑(照搬 deepseek-harness ui-chat 的 process-groups / process-activity / step-process)。
//
// ## 为什么要分组(这是与 dsh 对齐的关键差异)
// 之前每条工具调用**永久占一行**平铺在回复里。dsh 不是这样:一整段工具活动(连同思考)
// 会累积成**一个过程组**,组头是一句动态生成的人话标题,真正的工具行收进**可折叠的组体**。
// 好处:一回合跑了 20 次工具,收起时只占一行「已读取文件并修改了文件」,不把对话刷屏;
// 想看细节再展开。这就是"看起来不一样"的主要来源。
//
// ## 分组边界(逐字对齐 dsh 的 INDEPENDENT 集合 + 回复冲刷)
//   - 独立节点(user / steering / turn-trigger / model-retry / turn-error / 截断 / turn-tail)→ 关组;
//   - **有正文的回复 → 先关组再生效**(dsh: `if (reply(node)) { flush(true); ... }`),
//     所以"正文之前的工具活动"归一组,"正文之后的"另起一组 —— 这是最容易被忽略、也最影响观感的一条;
//   - 其余(工具调用、思考)累积进当前组。
//
// ## 折叠策略(对齐 dsh 的 stepGrouping / foldCompletedTurns)
//   - 正在进行的回合:**完全展开**(用户要看着它干活);
//   - 回合结束后:折叠成一行;且若之后还有别的正文回复,整组可以进一步隐藏(foldCompletedTurns)。
//
// 本模块**无 React 依赖**,可单测。
import type { ToolCallInfo } from '../types';

/** 活动分类(dsh 的 ProcessActivity,逐项对齐) */
export type ProcessActivity =
  | 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools';

/** 组内的一项:一次工具调用,或一段思考 */
export type ProcessItem =
  | { kind: 'tool'; call: ToolCallInfo }
  | { kind: 'reasoning'; text: string };

export interface ActivitySummary {
  /** 各分类的**去重调用数**,按数量降序(数量相同按首次出现顺序)—— dsh 用 Map 的插入序 + 稳定排序实现 */
  counts: Array<{ kind: ProcessActivity; count: number }>;
  /** 当前正在跑的活动类别(取最近开始的那次工具调用) */
  running?: ProcessActivity;
  /** 一句话实时详情(从参数里挑最像"任务名"的字段) */
  runningDetail: string;
  /** 工具还没进入 tool/call 阶段(准备中) */
  preparing?: true;
}

/**
 * 工具名 → 活动分类。逐条对齐 dsh 的 activity():
 * 注意 `*_inspect` 归 search、`terminal_*` 前缀归 commands、`subagent_*` 前缀归 subagents。
 * Teleforge 的工具名是"远程 + 本机"两套,所以两套都要映射到同一分类
 * (否则「读取文件」和「读取本机文件」会被算成两类,标题里会出现重复的"已读取文件")。
 */
export function activityOf(name: string): ProcessActivity {
  const n = name || '';
  // read
  if (n === 'read_file' || n === 'read_local_file' || n === 'read' || n === 'read_image') {
    return n === 'read_image' ? 'readImage' : 'read';
  }
  // search(grep/glob/搜索类 + dsh 的 *_inspect)
  if (n === 'search_code' || n === 'search_local_code' || n === 'grep' || n === 'grep_local'
    || n === 'glob' || n === 'glob_local' || n === 'list_directory' || n === 'list_local_dir'
    || n === 'available_skills' || n.endsWith('_inspect')) {
    return 'search';
  }
  // write
  if (n === 'write_file' || n === 'write_local_file' || n === 'write' || n === 'transfer_to_remote' || n === 'transfer_to_local') {
    return 'write';
  }
  // edit
  if (n === 'edit_file' || n === 'edit_local_file' || n === 'edit' || n === 'apply_patch') return 'edit';
  // commands:命令执行 + 终端类(Teleforge 的 AI 终端管理工具也算命令)
  if (n === 'run_command' || n === 'run_local_command' || n === 'bash' || n === 'pwsh'
    || n === 'exec_command' || n === 'write_stdin' || n.startsWith('terminal_')
    || n === 'list_project_terminals' || n === 'stop_project_terminal') {
    return 'commands';
  }
  if (n === 'run_code' || n === 'generate_image') return 'code';
  if (n === 'web_search') return 'webSearch';
  if (n === 'web_fetch') return 'webFetch';
  if (n === 'subagent' || n.startsWith('subagent_')) return 'subagents';
  if (n === 'todo_write' || n === 'create_goal' || n === 'update_goal' || n === 'get_goal') return 'plan';
  if (n === 'ask_user_question' || n === 'request_user_input') return 'questions';
  // 浏览器 / 电脑操控类归 tools(它们是一次具体操作,不构成"读/写/搜"的语义)
  return 'tools';
}

// ---- 实时详情:从参数里挑一句话 ----
// 键的优先级逐字对齐 dsh 的 LIVE_TOOL_DETAIL_KEYS:
// 越靠前越像"这个工具在干什么"的人话描述(command/query/path 之类在后面兜底)。
const LIVE_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions',
  'prompt', 'message', 'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri',
  'file_path', 'path', 'target', 'action', 'status'
] as const;

/** 实时详情最大字数(dsh LIVE_TOOL_DETAIL_MAX_CHARS = 160) */
export const LIVE_DETAIL_MAX_CHARS = 160;

/** 折叠空白 + 截断到 160 字;超出加省略号(按码点切,避免截断半个 emoji / 代理对) */
export function normalizeDetail(text: string): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= LIVE_DETAIL_MAX_CHARS) return s;
  const chars = Array.from(s);
  if (chars.length <= LIVE_DETAIL_MAX_CHARS) return s;
  return chars.slice(0, LIVE_DETAIL_MAX_CHARS - 1).join('').trimEnd() + '…';
}

function detailFromValue(value: unknown): string {
  if (typeof value === 'string') return normalizeDetail(value);
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
    return normalizeDetail(value.join(', '));
  }
  return '';
}

/**
 * 从一次工具调用的原始参数里挑出实时详情。
 * 参数在 Teleforge 里是**字符串**(流式时可能是半截 JSON),所以:
 *   1. 能解析成对象 → 按 dsh 的键优先级取第一个有文本的字段;
 *   2. 解析不了(流式半截)→ 退回对原始串做正则找 `"key":"value"`;
 *   3. 都没有 → 空串(调用方用工具标题兜底)。
 */
export function liveToolDetail(name: string, argsRaw: string): string {
  const raw = String(argsRaw ?? '').trim();
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key of LIVE_DETAIL_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
          const v = (obj as Record<string, unknown>)[key];
          // questions 是 [{question: '...'}] 形态:取第一个 question 字段
          if (key === 'questions' && Array.isArray(v)) {
            for (const item of v) {
              const d = item && typeof item === 'object'
                ? detailFromValue((item as Record<string, unknown>).question) : '';
              if (d) return d;
            }
            continue;
          }
          const d = detailFromValue(v);
          if (d) return d;
        }
        return '';
      }
    } catch { /* 半截 JSON:走下面的正则兜底 */ }
    // 流式半截 JSON 的兜底:按同样的键优先级找 "key":"value"。
    // ⚠ 值不能要求有闭合引号 —— 流式进行中最后一个字段往往是半截的(`{"command":"npm ru`),
    // 要求闭合就永远取不到它,而"实时详情"恰恰最需要在流式期间就显示出来。
    // JSON 字符串里不能出现裸引号,所以用 [^"]* 一路吃到下一个引号或输入末尾即可。
    for (const key of LIVE_DETAIL_KEYS) {
      const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)`).exec(raw);
      if (m && m[1]) {
        const d = normalizeDetail(m[1].replace(/\\"/g, '"').replace(/\\n/g, ' '));
        if (d) return d;
      }
    }
  }
  return '';
}

/** 思考兜底详情:取最后一段非空段落(去掉 markdown 粗体标记),逐字对齐 dsh 的 liveReasoningDetail */
export function liveReasoningDetail(items: readonly ProcessItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'reasoning') continue;
    const paragraphs = String(it.text || '').split(/\r?\n[\t ]*\r?\n/);
    for (let p = paragraphs.length - 1; p >= 0; p--) {
      const d = normalizeDetail(String(paragraphs[p] || '').replaceAll('**', ''));
      if (d) return d;
    }
  }
  return '';
}

/**
 * 汇总一个组的活动:分类计数(降序) + 正在跑什么 + 一句话详情。
 *
 * 去重按 callId(dsh 的 `seen` 集合):流式期间同一个调用可能被投递多次,重复计数会让
 * 标题出现「已读取文件并读取文件」这种荒谬结果。
 */
export function summarize(items: readonly ProcessItem[]): ActivitySummary {
  const counts = new Map<ProcessActivity, number>();
  const seen = new Set<string>();
  let running: ProcessActivity | undefined;
  let runningDetail = '';
  // 用"最后一次出现"而不是时间戳:Teleforge 的工具事件没有可靠的单调时间戳,
  // 而数组顺序就是发生顺序,倒序遍历取第一个 running 才是"最近开始的那次"
  for (const it of items) {
    if (it.kind !== 'tool') continue;
    const c = it.call;
    const id = c.id || '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const kind = activityOf(c.tool || '');
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'tool') continue;
    const c = it.call;
    if (callFinished(c)) continue; // 已有结果 = 不在跑
    running = activityOf(c.tool || '');
    runningDetail = liveToolDetail(c.tool || '', c.args || '');
    break;
  }
  if (running === undefined) runningDetail = liveReasoningDetail(items);
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    running,
    runningDetail
  };
}

// ---- 标题文案(逐字抄 dsh 的中文 locale) ----
const LIVE: Record<ProcessActivity | 'thinking', string> = {
  thinking: '正在分析请求', read: '正在读取文件', readImage: '正在读取图片', write: '正在写入文件',
  search: '正在搜索代码', edit: '正在编辑文件', commands: '正在运行命令', code: '正在运行代码',
  webSearch: '正在搜索网页', webFetch: '正在访问网页', subagents: '正在协调子智能体',
  plan: '正在更新计划', questions: '等待你的操作', tools: '正在调用工具'
};
const PREPARE: Record<ProcessActivity | 'thinking', string> = {
  thinking: '准备调用工具', read: '准备读取文件', readImage: '准备读取图片', write: '准备写入文件',
  search: '准备搜索代码', edit: '准备编辑文件', commands: '准备运行命令', code: '准备运行代码',
  webSearch: '准备搜索网页', webFetch: '准备访问网页', subagents: '准备协调子智能体',
  plan: '准备更新计划', questions: '准备提问', tools: '准备调用工具'
};
const DONE: Record<ProcessActivity | 'thinking', string> = {
  thinking: '已完成分析', read: '已读取文件', readImage: '已读取图片', write: '已写入文件',
  search: '已搜索代码', edit: '修改了文件', commands: '执行了命令', code: '运行了代码',
  webSearch: '已搜索网页', webFetch: '已访问网页', subagents: '已协调子智能体',
  plan: '更新了计划', questions: '向用户提出了问题', tools: '已调用工具'
};

/** 运行中的标签(准备中时用"准备…")。dsh: preparing 时 thinking 等价于 tools */
export function liveLabel(summary: ActivitySummary): string {
  const kind = summary.running ?? 'thinking';
  if (summary.preparing) return PREPARE[kind] ?? PREPARE.tools;
  return LIVE[kind] ?? LIVE.tools;
}

/**
 * 已结束的组标题:dsh 的 processTitle —— 取前三个分类,首字母不需要处理(中文),
 * 但**共享前缀要去掉**(dsh 的 sharedPrefix '已'):「已读取文件」+「已搜索代码」
 * → 「已读取文件并搜索代码」,而不是「已读取文件并已搜索代码」。
 */
export function doneTitle(summary: ActivitySummary): string {
  const labels = summary.counts.slice(0, 3).map(({ kind }) => DONE[kind] ?? DONE.tools);
  const first = labels[0];
  if (first === undefined) return DONE.thinking;
  const second = labels[1];
  if (second === undefined) return first;
  if (labels.length === 2) {
    // 只有两项的「并」才省略第二项的「已」(dsh 的 sharedPrefix 就用在 joinTwo 这一支)
    const PREFIX = '已';
    const shared = first.startsWith(PREFIX) && second.startsWith(PREFIX);
    return `${first}并${shared ? second.slice(PREFIX.length) : second}`;
  }
  // 三项及以上:直接用中文逗号连接,不做前缀省略(dsh 三项分支只做英文首字母小写)
  const title = labels.join('，');
  return summary.counts.length > 3 ? `${title}等` : title;
}

/** 组头完整标题:结束后=已结束文案;运行中=「正在X · 详情」(详情为空则只有前半句) */
export function groupTitle(summary: ActivitySummary, closed: boolean): string {
  if (closed) return doneTitle(summary);
  const label = liveLabel(summary);
  return summary.runningDetail ? `${label} · ${summary.runningDetail}` : label;
}

// ---- 回合过程折叠行(对齐 dsh 的 TurnProcessNodeView)----
//
// 这一层与上面的"过程组"是**两个不同的控件**,别混:
//   TurnProcessNodeView(本段) = 整个**回合**的过程折叠,折叠行只有一句「已完成,用时 2分19秒」,
//                              它把整轮的工具活动收起来,**内容不限高**(dsh 的 uncapped 模式);
//   ChatGroupSeat(上面 summarize/doneTitle 那部分) = 回合**内部**的工具活动分组,
//                              组头是「已读取文件并修改了文件」,它的组体才有 min(400px,50vh) 上限。
// 我最初把内层的文案与限高直接搬到了最外层,于是折叠行显示成「已调用工具,执行了命令…」,
// 一点开还立刻出现滚动条 —— 两个症状同一个根因。

/** 时长片段(dsh 的 RunDurationPart:数字与单位分开,便于给数字单独套等宽字体) */
export interface RunDurationPart { text: string; numeric: boolean }

/**
 * 把毫秒拆成 时/分/秒 片段。逐字对齐 dsh 的 formatRunDuration:
 *   - 负数夹到 0,毫秒向下取整到秒;
 *   - 不足 1 分钟**只出秒**;≥1 分钟才出分;≥1 小时才出时;
 *   - 秒**总是**输出(所以 2 分整会显示「2分0秒」,而不是「2分」)。
 */
export function formatRunDuration(ms: number): RunDurationPart[] {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const parts: RunDurationPart[] = [];
  if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: '小时', numeric: false });
  if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: '分', numeric: false });
  parts.push({ text: String(seconds), numeric: true }, { text: '秒', numeric: false });
  return parts;
}

/** 结束原因(dsh 的 reason.kind) */
export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max-iters' | string;

/**
 * 折叠行的「前缀文本 + 时长片段」。**字符串形式与 JSX 形式共用这一份**,避免两处口径漂移:
 *   - `turnProcessLabel` 把片段拼成纯文本(测试与无障碍用);
 *   - 组件按片段渲染,只给**数字**片段套等宽字体 + tabular-nums,这样耗时变化时宽度不抖。
 *
 * 逐字对齐 dsh:已停止 / 处理失败 **都不显示耗时**(dsh 判断 `reason === 'aborted' || 'error'`
 * → duration undefined);有耗时是「已完成,用时 」—— 注意「用时」后面**有一个空格**。
 */
export function turnProcessParts(
  reason: TurnEndReason | undefined, elapsedMs: number | undefined
): { prefix: string; parts: RunDurationPart[] } {
  if (reason === 'aborted') return { prefix: '已停止', parts: [] };
  if (reason === 'error') return { prefix: '处理失败', parts: [] };
  if (elapsedMs === undefined || elapsedMs === null) return { prefix: '已完成', parts: [] };
  return { prefix: '已完成，用时 ', parts: formatRunDuration(elapsedMs) };
}

/** 折叠行的纯文本形式(测试/无障碍/标题用) */
export function turnProcessLabel(reason: TurnEndReason | undefined, elapsedMs: number | undefined): string {
  const { prefix, parts } = turnProcessParts(reason, elapsedMs);
  return prefix + parts.map((p) => p.text).join('');
}

// ---- 分组 ----

/**
 * 对话显示模式(对齐 dsh 的 TranscriptViewMode 三档,默认取 dsh 的默认值 standard):
 *   standard —— 过程组总是折成一行(运行中也只有那行扫光标题 + 实时详情),点开展开;
 *   detailed —— 只在回合结束后折叠,进行中的回合完全展开(能看着它一步步干);
 *   verbose  —— 从不折叠,工具行全部平铺(诊断/教学用)。
 * 这是**唯一**控制"工具行默认可见性"的开关,改成别的档位只需要改这里。
 */
export const TRANSCRIPT_MODE: 'standard' | 'detailed' | 'verbose' = 'standard';

/** 该模式的某条消息是否要把过程组折成一行 */
export function groupedFor(mode: typeof TRANSCRIPT_MODE, streaming: boolean): boolean {
  if (mode === 'verbose') return false;
  if (mode === 'detailed') return !streaming;
  return true;
}

/** 渲染单元:正文段独立渲染;连续的「思考 + 工具」串构成一个过程组 */
export type ProcessUnit =
  | { kind: 'text'; index: number }
  | { kind: 'group'; memberIndexes: number[]; items: ProcessItem[]; summary: ActivitySummary };

/** 一次工具调用是否已经落下结果。
 *
 * ⚠ 判"结束"要看 `ok`,不能只看 `ms`:
 *   - 实时路径里 tool_call 起始填的是 { ok: undefined, ms: undefined },而 tool_result
 *     **一定会**填 ok(见 ChatPanel 的 patch);只判 ms 的话,服务端没上报耗时的调用
 *     会被永远当成"在跑",组头就一直在转圈。
 *   - 历史回放路径(projectEvents/turnsToMessages)构造时也填 ok。
 * 因此:ok 有值 = 结果已到达;再兜底 ms / result 有值也算结束。 */
function callFinished(c: ToolCallInfo): boolean {
  if (c.ok !== undefined) return true;
  if (c.ms !== null && c.ms !== undefined) return true;
  if (c.result !== null && c.result !== undefined) return true;
  return false;
}

/** 一次工具调用是否"仍在进行":还没有结果,且没有被判定失败 */
function callIsLive(c: ToolCallInfo): boolean {
  return !callFinished(c);
}

/** 组里是否还有在跑的东西:组头的 shimmer 与"运行中不折叠"都据此决定 */
export function isGroupLive(items: readonly ProcessItem[]): boolean {
  return items.some((it) => it.kind === 'tool' && callIsLive(it.call));
}

/**
 * 把一条 assistant 消息的 segments 切成渲染单元。
 *
 * 对齐 dsh 的规则:**有正文就关组**(`if (reply(node)) { flush(true); ... }`)。
 * 所以 `text` 段是分隔符:每个连续的 `reasoning | tools` 串构成一个过程组,
 * 正文段各自独立渲染。这样"正文之前的工具活动"与"正文之后的"自然分成两组,
 * 而不是被错误地合成一大坨。
 */
export function planGroups(
  segments: ReadonlyArray<{ kind: string; text?: string; tools?: ToolCallInfo[] }>
): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  let current: Extract<ProcessUnit, { kind: 'group' }> | null = null;
  segments.forEach((seg, i) => {
    if (seg.kind === 'text') {
      current = null; // 正文冲刷当前组
      units.push({ kind: 'text', index: i });
      return;
    }
    if (seg.kind !== 'reasoning' && seg.kind !== 'tools') return; // 未知段型:不参与分组,也不丢
    if (!current) {
      current = { kind: 'group', memberIndexes: [], items: [], summary: { counts: [], running: undefined, runningDetail: '' } };
      units.push(current);
    }
    current.memberIndexes.push(i);
    if (seg.kind === 'reasoning') current.items.push({ kind: 'reasoning', text: seg.text || '' });
    else for (const call of seg.tools || []) current.items.push({ kind: 'tool', call });
  });
  // 汇总只算一次(渲染时读 unit.summary,不必每帧重算)
  for (const u of units) if (u.kind === 'group') u.summary = summarize(u.items);
  return units;
}
