// 工具注册表与执行管线(设计参照 deepseek-harness 的 tools 子系统):
// - register/get/schemas:schemas() 只向模型投影 name/description/parameters 三个
//   白名单字段,执行函数、超时等宿主元数据绝不进入模型请求。
// - guard:pre-execute 单调守卫——只能拒绝(返回理由),不能推翻其他守卫的拒绝;
//   返回 undefined 表示不干预。
// - execute() 管线:查找 -> 参数解析 -> 守卫 -> 带超时执行 -> 结果规范化。
//   未知工具、非法参数、守卫拒绝、超时与异常一律变成结构化错误结果(isError)
//   而不是抛异常:单个工具调用失败只影响它自己,绝不终结整轮
//   (参照 harness:the call fails without ending the turn)。
import { AGENT } from '../config.js';
import { toolSettings } from './tool-settings.js';

// 注册表级兜底超时(工具自身可声明更短的 timeoutMs)
const DEFAULT_TIMEOUT_MS = 660_000;

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.guards = [];
  }

  /** 注册一个工具,返回卸载器(对齐 harness register 的 disposer 语义) */
  register(def) {
    if (!def?.name || typeof def.run !== 'function') {
      throw new Error(`工具定义非法(缺 name/run): ${def?.name || '(无名)'}`);
    }
    this.tools.set(def.name, def);
    return () => this.tools.delete(def.name);
  }

  /** 注册单调守卫:返回字符串理由即拒绝,返回 undefined 不干预 */
  guard(fn) {
    this.guards.push(fn);
    return () => {
      const i = this.guards.indexOf(fn);
      if (i >= 0) this.guards.splice(i, 1);
    };
  }

  get(name) { return this.tools.get(name); }

  /** 全部已注册工具定义(设置面板列出用;含启用状态) */
  listAll() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      enabled: toolSettings.isEnabled(t.name)
    }));
  }

  /** 模型可见的 ToolSchema 白名单投影(深拷贝,防调用方篡改定义);被禁用的工具不投影 */
  schemas() {
    return [...this.tools.values()]
      .filter((t) => toolSettings.isEnabled(t.name))
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
   * 执行一次工具调用,永远 resolve 为规范化结果:
   * { isError: boolean, content: string, ms: number }
   * @param {{name: string, args: string|object, signal?: AbortSignal, invokeCtx?: object}} call
   *   invokeCtx:调用方上下文(如 {sid, session, emit}),原样并入工具 run 的第二参数,
   *   供 todo_write 这类需要写会话事件日志的工具使用;普通工具忽略它。
   */
  async execute({ name, args, signal, invokeCtx }) {
    const started = Date.now();
    const fail = (content) => ({ isError: true, content, ms: Date.now() - started });

    const tool = this.tools.get(name);
    if (!tool) return fail(`未知工具: ${name}`);
    // 被禁用的工具(设置 → 工具插件):模型看不到其 schema,这里拒绝兜底
    if (!toolSettings.isEnabled(name)) return fail(`工具 ${name} 已被禁用(可在设置 → 工具插件中重新启用)`);

    let parsed;
    try {
      parsed = typeof args === 'string' ? JSON.parse(args) : (args || {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      return fail(`工具参数不是合法 JSON: ${String(args).slice(0, 200)}`);
    }

    // pre-execute 守卫:任一守卫给出理由即拒绝;守卫只能收紧,不能放行
    for (const guard of this.guards) {
      let reason;
      try { reason = guard(name, parsed); } catch { reason = '守卫执行异常'; }
      if (reason) return fail(`工具调用被拒绝: ${reason}`);
    }

    try {
      const content = await runWithTimeout(tool.run(parsed, { signal, ...(invokeCtx || {}) }), tool.timeoutMs || DEFAULT_TIMEOUT_MS, signal);
      return { isError: false, content: capResult(String(content ?? '')), ms: Date.now() - started };
    } catch (e) {
      return fail(`工具执行错误: ${e.message}`);
    }
  }
}

// 带超时/中止的执行包装:超时或 signal 中止时立刻拒绝
function runWithTimeout(p, ms, signal) {
  const promise = p instanceof Promise ? p : Promise.resolve(p);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工具执行超时(${Math.round(ms / 1000)}s)`)), ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('已停止')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (fn) => (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); };
    promise.then(done(resolve), done(reject));
  });
}

// 结果截断:保留头尾、折叠中段(与工具内部整形独立的双保险)
function capResult(s, max = AGENT.TOOL_RESULT_MAX_CHARS) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.6))
    + `\n…[结果过长,已截断,剩余 ${s.length - max} 字符,可缩小范围重试]…\n`
    + s.slice(s.length - Math.floor(max * 0.4));
}
