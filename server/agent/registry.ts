// 工具注册表与执行管线(设计 的 tools 子系统):
// - register/get/schemas:schemas() 只向模型投影 name/description/parameters 三个
//   白名单字段,执行函数、超时等宿主元数据绝不进入模型请求。
// - guard:pre-execute 单调守卫——只能拒绝(返回理由),不能推翻其他守卫的拒绝;
//   返回 undefined 表示不干预。
// - execute() 管线:查找 -> 参数解析 -> 守卫 -> 带超时执行 -> 结果规范化。
//   未知工具、非法参数、守卫拒绝、超时与异常一律变成结构化错误结果(isError)
//   而不是抛异常:单个工具调用失败只影响它自己,绝不终结整轮
//   (参照 harness:the call fails without ending the turn)。
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
  [k: string]: any;
}

export type GuardFn = (name: string, args: any) => string | void | undefined | Promise<string | void | undefined>;

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
   * 模型可见的 ToolSchema 白名单投影(深拷贝,防调用方篡改定义);被禁用的工具不投影。
   * localOnly=true(未连接 SSH 的本地模式)时,带 remote 标记的工具一并剔除,
   * 模型只能看到本机工具与技能/任务清单等非远程工具,从源头避免触发"SSH 连接已断开"。
   */
  schemas({ localOnly = false }: { localOnly?: boolean } = {}): any[] {
    return [...this.tools.values()]
      .filter((t) => toolSettings.isEnabled(t.name))
      .filter((t) => !(localOnly && t.remote))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: JSON.parse(JSON.stringify(t.parameters || { type: 'object', properties: {}, required: [] }))
        }
      }));
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

    // pre-execute 守卫:任一守卫给出理由即拒绝;守卫只能收紧,不能放行
    for (const guard of this.guards) {
      let reason: any;
      try { reason = guard(name, parsed); } catch { reason = '守卫执行异常'; }
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
        isError: false, content: capResult(content), ms: Date.now() - started,
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

// 结果截断:保留头尾、折叠中段(与工具内部整形独立的双保险);
// 截断时追加 retrievalHint,提示模型中段/尾部可分段再取(对齐 harness spill 思路),
// 避免模型拿不到关键信息而反复做同样的探测调用。
const TRUNCATION_HINT = '\n[结果过长已截断:中段内容被省略。若需中段/尾部细节,可用 read_file(offset/limit) 或 run_command 缩小范围再取,不要重复相同调用]';
function capResult(s: string, max: number = AGENT.TOOL_RESULT_MAX_CHARS): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.6))
    + `\n…[结果过长,已截断,剩余 ${s.length - max} 字符]…\n`
    + s.slice(s.length - Math.floor(max * 0.4))
    + TRUNCATION_HINT;
}
