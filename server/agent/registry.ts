// 工具注册表与执行管线(设计参照 deepseek-harness 的 tools 子系统):
// - register/get/schemas:schemas() 只向模型投影 name/description/parameters 三个
//   白名单字段,执行函数、超时等宿主元数据绝不进入模型请求。
// - guard:pre-execute 单调守卫——只能拒绝(返回理由),不能推翻其他守卫的拒绝;
//   返回 undefined 表示不干预。
// - execute() 管线:查找 -> 参数解析 -> 守卫 -> 带超时执行 -> spill 整形 -> 结果规范化。
//   未知工具、非法参数、守卫拒绝、超时与异常一律变成结构化错误结果(isError)
//   而不是抛异常:单个工具调用失败只影响它自己,绝不终结整轮
//   (参照 harness:the call fails without ending the turn)。
// - spill 策略(照搬 harness spill-policy):纯文本结果超过 SPILL_MAX_BYTES 时,
//   入历史前替换为头尾对半预览 + 省略提示;read 工具豁免(防 read→spill→read 循环)。
import { AGENT } from '../config.ts';
import { toolSettings } from './tool-settings.ts';

// 注册表级兜底超时(工具自身可声明更短的 timeoutMs)
const DEFAULT_TIMEOUT_MS = 660_000;

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: object;
  run: (args: any, ctx: any) => any | Promise<any>;
  timeoutMs?: number;
  remote?: boolean;
  /**
   * 是否改变外部状态(写文件/建目录/删除等)。mutating 调用在并行池里必须独占执行,
   * 与其它任何调用并发都可能产生 read-modify-write 竞态(如两条 edit_file 同文件,
   * 后读的一方覆盖先写的一方的更新)。
   */
  mutating?: boolean;
  /**
   * 是否并发安全(对齐 harness ToolDef.isConcurrencySafe):并行池里只有显式声明
   * concurrencySafe=true 的工具(只读探测/命令执行)之间才并行;未声明一律按不安全
   * 处理(fail-closed,与 mutating 同样独占)。
   */
  concurrencySafe?: boolean;
  [k: string]: any;
}

// guard 第三参 ctx 为执行上下文({signal, ...invokeCtx},含 sid/session/emit),
// 供权限守卫读取会话模式并向用户发起审批;同步守卫忽略它即可。
export type GuardFn = (name: string, args: any, ctx?: any) => string | void | undefined | Promise<string | void | undefined>;

export interface ToolResult {
  isError: boolean;
  content: string;
  ms: number;
  concludesTurn?: boolean;
  meta?: any;
}

export class ToolRegistry {
  tools: Map<string, ToolDef> = new Map();
  guards: GuardFn[] = [];
  // schemas() 投影缓存:键 = 启用工具名集合 + localOnly。注册/注销/启停/模式切换
  // 任一变化都会改变键,天然失效。省掉每步对 20+ 工具 schema 的深拷贝序列化。
  private _schemasCache: { key: string; schemas: any[] } | null = null;

  /** 注册一个工具,返回卸载器(对齐 harness register 的 disposer 语义) */
  register(def: ToolDef): () => void {
    if (!def?.name || typeof def.run !== 'function') {
      throw new Error(`工具定义非法(缺 name/run): ${def?.name || '(无名)'}`);
    }
    this.tools.set(def.name, def);
    return () => this.tools.delete(def.name);
  }

  /** 注册单调守卫:返回字符串理由即拒绝,返回 undefined 不干预 */
  guard(fn: GuardFn): () => void {
    this.guards.push(fn);
    return () => {
      const i = this.guards.indexOf(fn);
      if (i >= 0) this.guards.splice(i, 1);
    };
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name); }

  /** 全部已注册工具定义(设置面板列出用;含启用状态) */
  listAll(): Array<{ name: string; description?: string; enabled: boolean }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      enabled: toolSettings.isEnabled(t.name)
    }));
  }

  /**
   * 模型可见的 ToolSchema 白名单投影(结果缓存;被禁用的工具不投影)。
   * localOnly=true(未连接 SSH 的本地模式)时,带 remote 标记的工具一并剔除,
   * 模型只能看到本机工具与技能/任务清单等非远程工具,从源头避免触发"SSH 连接已断开"。
   * 返回的是缓存对象,调用方不得原地修改(现有调用只读序列化进请求体)。
   */
  schemas({ localOnly = false }: { localOnly?: boolean } = {}): any[] {
    const entries = [...this.tools.values()].filter((t) => toolSettings.isEnabled(t.name));
    const key = entries.map((t) => t.name).join(',') + '|' + (localOnly ? 'L' : 'R');
    if (this._schemasCache && this._schemasCache.key === key) return this._schemasCache.schemas;
    const schemas = entries
      .filter((t) => !(localOnly && t.remote))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: JSON.parse(JSON.stringify(t.parameters || { type: 'object', properties: {}, required: [] }))
        }
      }));
    this._schemasCache = { key, schemas };
    return schemas;
  }

  /** 是否并发安全(并行池互斥依据,见 ToolDef.concurrencySafe):未知工具/未声明一律不安全(fail-closed) */
  isConcurrencySafe(name: string): boolean {
    const def = this.tools.get(name);
    if (!def || def.mutating) return false;
    return def.concurrencySafe === true;
  }

  /**
   * 执行一次工具调用,永远 resolve 为规范化结果。
   * concludesTurn:工具 run 返回 {content, concludesTurn:true} 时透传,让工具能显式
   * 宣告"本轮到此为止"(移植 harness 的 ToolRunContext.concludeTurn),替代纯靠
   * 模型"不再调工具"的隐式完成。
   * invokeCtx:调用方上下文(如 {sid, session, emit}),原样并入工具 run 的第二参数,
   * 供 todo_write 这类需要写会话事件日志的工具使用;普通工具忽略它。
   */
  async execute({ name, args, signal, invokeCtx }: { name: string; args: string | object; signal?: AbortSignal; invokeCtx?: any }): Promise<ToolResult> {
    const started = Date.now();
    const fail = (content: string): ToolResult => ({ isError: true, content, ms: Date.now() - started });

    const tool = this.tools.get(name);
    if (!tool) return fail(`未知工具: ${name}`);
    // 被禁用的工具(设置 → 工具插件):模型看不到其 schema,这里拒绝兜底
    if (!toolSettings.isEnabled(name)) return fail(`工具 ${name} 已被禁用(可在设置 → 工具插件中重新启用)`);

    let parsed: any;
    try {
      parsed = typeof args === 'string' ? JSON.parse(args) : (args || {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      return fail(`工具参数不是合法 JSON: ${String(args).slice(0, 200)}`);
    }

    // pre-execute 守卫:任一守卫给出理由即拒绝;守卫只能收紧,不能放行。
    // await 兼容异步守卫(权限守卫的审批会阻塞到用户作答)
    for (const guard of this.guards) {
      let reason: any;
      try { reason = await guard(name, parsed, { signal, ...(invokeCtx || {}) }); } catch { reason = '守卫执行异常'; }
      if (reason) return fail(`工具调用被拒绝: ${reason}`);
    }

    try {
      const rawResult = await runWithTimeout(tool.run(parsed, { signal, ...(invokeCtx || {}) }), tool.timeoutMs || DEFAULT_TIMEOUT_MS, signal);
      // 工具可返回字符串(普通)、{content, concludesTurn}(显式收尾信号)或
      // {content, meta}(结构化 UI 数据,如终端卡的 exitCode/cwd,见 tools.js)
      const content = typeof rawResult === 'string' ? rawResult
        : rawResult && typeof rawResult === 'object' ? String(rawResult.content ?? '')
        : String(rawResult ?? '');
      const concludesTurn = !!(rawResult && typeof rawResult === 'object' && rawResult.concludesTurn === true);
      const meta = rawResult && typeof rawResult === 'object' ? rawResult.meta : undefined;
      return {
        isError: false, content: spillResult(content, name), ms: Date.now() - started,
        ...(concludesTurn ? { concludesTurn: true } : {}),
        ...(meta !== undefined ? { meta } : {})
      };
    } catch (e: any) {
      return fail(`工具执行错误: ${e.message}`);
    }
  }
}

// 带超时/中止的执行包装:超时或 signal 中止时立刻拒绝
function runWithTimeout(p: any, ms: number, signal?: AbortSignal): Promise<any> {
  const promise = p instanceof Promise ? p : Promise.resolve(p);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工具执行超时(${Math.round(ms / 1000)}s)`)), ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('已停止')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (fn: any) => (v: any) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    promise.then(done(resolve), done(reject));
  });
}

// ---- spill 策略(照搬 harness spill-policy,tools/post-execute 位置的通用兜底) ----
// 纯文本结果超过 SPILL_MAX_BYTES 时,替换为头尾对半预览 + 省略提示(通知不计入预算,
// 保证替换结果永不超 cap);read 工具豁免——读取本身就是"回看完整内容"的手段,
// 再把读到的内容折叠掉会造成 read→spill→read 的空转循环。
const SPILL_SKIP_TOOLS = new Set(['read_file', 'read_local_file']);

// 从尾部修剪悬空的 UTF-8 多字节序列(截断点落在字符中间时丢弃半个字符)
function trimUtf8Tail(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) end--;
  if (end > 0 && (buf[end - 1] & 0x80) !== 0) end--; // 再去掉多字节序列的起始字节
  return buf.subarray(0, end);
}

function spillResult(content: string, toolName: string): string {
  if (!content) return content;
  if (SPILL_SKIP_TOOLS.has(toolName)) return content;
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= AGENT.SPILL_MAX_BYTES) return content;
  const half = Math.floor(AGENT.SPILL_MAX_BYTES / 2);
  const head = trimUtf8Tail(buf.subarray(0, half)).toString('utf8');
  const tail = trimUtf8Tail(buf.subarray(buf.length - half)).toString('utf8');
  const omitted = buf.length - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return head
    + `\n\n[${Math.round(omitted / 1024)}KB 已省略。以上为结果的头尾摘录;如需中段细节,请用更精确的参数重新调用该工具(缩小搜索范围/分段读取/提高过滤条件)]\n\n`
    + tail;
}
