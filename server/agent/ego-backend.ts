// ego(lite) 后端:把 ego-browser CLI 包装成与"真机扩展 / 内置预览"同一套 BrowserOps。
//
// 关键取舍:
//   1) 每次动作起一个 `ego-browser nodejs` 进程(官方接入方式),截图/批处理把多步压进一次调用;
//   2) ego 的 @N 只在产生它的进程内有效,所以快照解析出 `loc=` 作为跨进程锚点,对外用稳定的
//      `e3f1a` 形式的 ref;点它时再翻译回 `loc=...`;
//   3) ego 自带 Space / TaskSpace 生命周期:空间名按 Teleforge 会话固定,后续调用自然接着用同一空间。
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { egoBinaryPath, runEgo, normalizeEgoSnapshot, egoTarget } from '../core/ego-browser.ts';
import type { BatchResult, BatchStep, SnapshotOptions } from '../core/browser-manager.ts';
import type { TargetState } from './browser-backends.ts';

const SPACE_PREFIX = 'teleforge';

/** 每个会话最近一次快照的 ref → loc 映射(snapshot 时写入,动作时读取) */
const refMaps = new Map<string, Map<string, string>>();
/** 每个会话最近一次见到的页面状态 */
const lastState = new Map<string, TargetState>();

export function egoSpaceName(sid: string | null | undefined): string {
  const raw = String(sid || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'default';
  return `${SPACE_PREFIX}-${raw}`;
}

/** 只判断"命令在不在";App 没启动时第一次调用会给出明确报错 */
export function egoInstalled(): boolean {
  return !!egoBinaryPath();
}

function refMapOf(space: string): Map<string, string> {
  let m = refMaps.get(space);
  if (!m) { m = new Map(); refMaps.set(space, m); }
  return m;
}

function rememberState(space: string, url: unknown, title: unknown): TargetState {
  const st = { url: String(url || ''), title: String(title || ''), error: null };
  lastState.set(space, st);
  return st;
}

const json = (v: unknown) => JSON.stringify(v);

/** 截断一长串文本,避免把错误信息写成一个页面 */
const short = (v: unknown, n = 120) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/**
 * 生成"一个动作"的脚本主体。所有动作都带上当前 url/title 回执:
 * ego 的页面对象每次调用都要重新拿,状态得回传,否则 state() 永远是空的。
 */
function actionBody(pageExpr: string): string {
  return `const __u = await ${pageExpr}.url(); const __t = await ${pageExpr}.title(); __ok({ url: __u, title: __t });`;
}

function fmtSnapshot(payload: Record<string, any>, space: string, opts: SnapshotOptions = {}): string {
  const snap = normalizeEgoSnapshot(String(payload.text || ''));
  const map = refMapOf(space);
  map.clear();
  for (const [k, v] of snap.refs) map.set(k, v);
  const st = rememberState(space, payload.url, payload.title);
  const lines = [
    `页面标题:${st.title || '(无标题)'}`,
    `地址:${st.url}`,
    `空间:${space} · ego(lite)${opts.scope === 'full_page' ? ' · 整页' : ' · 当前视口'}`,
    '',
    '页面结构(ego 语义快照;ref 形如 e3f1a,跨调用可用):',
    snap.text || '(空快照)'
  ];
  if (!snap.refs.size) {
    lines.push('', '(这次快照里没有可用稳定定位的元素:可以改用 selector / text 指定目标)');
  }
  return lines.join('\n');
}

/** 把一个 batch step 翻译成脚本里的一段分支 */
function stepCode(step: BatchStep, space: string): string {
  const op = String(step.op || '').toLowerCase();
  const target = step.ref || step.selector || step.text
    ? egoTarget(step.ref, step.selector, step.text, refMapOf(space))
    : '';
  switch (op) {
    case 'click':
      return `await __page.click(${json(target)}); detail = ${json(`已点击:${target}`)}; break;`;
    case 'type':
    case 'fill':
      return `await __page.fill(${json(target)}, ${json(String(step.text ?? ''))}); detail = ${json(`已输入:${target}`)}; break;`;
    case 'hover':
      return `await __page.hover(${json(target)}); detail = ${json(`已悬停:${target}`)}; break;`;
    case 'dblclick':
      return `await __page.dblclick(${json(target)}); detail = ${json(`已双击:${target}`)}; break;`;
    case 'select': {
      const opt = step.label != null ? json({ label: String(step.label) }) : json({ value: String(step.value ?? '') });
      return `await __page.selectOption(${json(target)}, ${opt}); detail = ${json(`已选择:${target}`)}; break;`;
    }
    case 'upload':
      return `await __page.setInputFiles(${json(target)}, ${json(step.files || [])}); detail = ${json(`已上传:${target}`)}; break;`;
    case 'press':
      return `await __page.press(${json(String(step.key || 'Enter'))}); detail = ${json(`已按键:${step.key || 'Enter'}`)}; break;`;
    case 'scroll': {
      const dy = String(step.direction || '').toLowerCase() === 'up'
        ? -Math.abs(Number(step.amount) || 600) : Math.abs(Number(step.amount) || 600);
      return `await __page.evaluate("window.scrollBy(0, ${dy})"); detail = ${json(`已滚动 ${dy}px`)}; break;`;
    }
    case 'navigate':
    case 'goto':
      return `await __page.goto(${json(String(step.url || ''))}); await __page.waitForLoadState("load").catch(() => {}); detail = ${json(`已打开:${step.url}`)}; break;`;
    case 'wait': {
      const ms = Math.max(200, Math.min(Number(step.timeoutMs) || 8000, 60_000));
      if (step.selector) return `await __page.waitForSelector(${json(String(step.selector))}, { timeout: ${ms} }); detail = "等待选择器完成"; break;`;
      if (step.text) return `await __page.waitForFunction((t) => String((document.body && document.body.innerText) || "").includes(t), ${json(String(step.text))}, { timeout: ${ms} }); detail = "等待文本完成"; break;`;
      if (step.url) return `await __page.waitForURL(${json(String(step.url))}, { timeout: ${ms} }); detail = "等待 URL 完成"; break;`;
      return `await __page.waitForTimeout(${ms}); detail = "等待 ${ms}ms"; break;`;
    }
    case 'networkidle':
      return `await __page.waitForNetworkIdle({ timeout: ${Math.min(Number(step.timeoutMs) || 10_000, 60_000)} }).catch(() => {}); detail = "网络空闲"; break;`;
    case 'assert': {
      const want = String(step.text || '');
      if (!want) throw new Error('assert 需要 text');
      return `const __body = String(await __page.evaluate("String((document.body && document.body.innerText) || \\"\\")")); if (!__body.includes(${json(want)})) throw new Error("断言失败:页面里没有 " + ${json(want)}); detail = "断言通过"; break;`;
    }
    case 'text':
      return `detail = String(await __page.evaluate("String((document.body && document.body.innerText) || \\"\\")")).slice(0, ${Math.max(100, Number(step.max) || 800)}); break;`;
    case 'eval':
      return `detail = JSON.stringify(await __page.evaluate(${json(String(step.expression || step.value || ''))})); break;`;
    default:
      throw new Error(`ego 后端不支持的操作:${step.op}`);
  }
}

export interface EgoOpsOptions {
  sid?: string | null;
  url?: string | null;
}

/** 构建 ego 后端的 BrowserOps(接口与 native/preview 完全一致) */
export function egoOps(opts: EgoOpsOptions = {}) {
  const space = egoSpaceName(opts.sid);
  if (opts.url) rememberState(space, opts.url, '');

  const run = (body: string, timeoutMs = 60_000) => runEgo(space, body, { timeoutMs });

  return {
    kind: 'ego' as const,
    id: `ego:${space}`,
    tabId: null as number | null,
    state(): TargetState | null {
      return lastState.get(space) || null;
    },
    async openUrl(url: string): Promise<TargetState> {
      const p = await run(`
await __page.goto(${json(url)});
await __page.waitForLoadState("load").catch(() => {});
${actionBody('__page')}`, 90_000);
      return rememberState(space, p.url, p.title);
    },
    async navigate(url: string): Promise<TargetState> {
      const p = await run(`
await __page.goto(${json(url)});
await __page.waitForLoadState("load").catch(() => {});
${actionBody('__page')}`, 90_000);
      return rememberState(space, p.url, p.title);
    },
    async snapshot(o: SnapshotOptions = {}): Promise<string> {
      const scope = o.scope === 'subtree'
        ? `{ scope: "subtree", root: ${json(o.root || '')} }`
        : (o.scope === 'full_page' ? '{ scope: "full_page" }' : '{}');
      const p = await run(`
const __text = await __page.snapshot(${scope});
__ok({ text: __text, url: await __page.url(), title: await __page.title() });`, 45_000);
      return fmtSnapshot(p, space, o);
    },
    async click(t: { ref?: string; selector?: string; text?: string }): Promise<string> {
      const target = egoTarget(t.ref, t.selector, t.text, refMapOf(space));
      const p = await run(`
await __page.click(${json(target)});
${actionBody('__page')}`, 45_000);
      rememberState(space, p.url, p.title);
      return `已点击:${short(target)}`;
    },
    async fill(t: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean }): Promise<string> {
      const target = egoTarget(t.ref, t.selector, undefined, refMapOf(space));
      const text = String(t.text ?? '');
      const p = await run(`
const __ft = ${json(target)};
if (${t.clear !== false ? 'true' : 'false'}) { try { await __page.fill(__ft, ""); } catch (e) {} }
await __page.fill(__ft, ${json(text)});
${t.submit ? 'await __page.press("Enter");' : ''}
${actionBody('__page')}`, 45_000);
      rememberState(space, p.url, p.title);
      // 回读校验:ego 的 fill 走 CDP,一般没问题;读不到就明说,不假装成功
      return `已输入到 ${short(target)}${t.submit ? ',并回车提交' : ''}`;
    },
    async press(key: string): Promise<string> {
      await run(`
try { await __page.press(${json(key)}); } catch (e) { await __page.keyboard.press(${json(key)}); }
__ok({});`, 30_000);
      return `已按键:${key}`;
    },
    async scroll(o: { direction?: string; amount?: number }): Promise<string> {
      const dy = String(o.direction || '').toLowerCase() === 'up'
        ? -Math.abs(Number(o.amount) || 600) : Math.abs(Number(o.amount) || 600);
      await run(`await __page.evaluate("window.scrollBy(0, ${dy})"); __ok({});`, 30_000);
      return `已向${dy > 0 ? '下' : '上'}滚动 ${Math.abs(dy)}px`;
    },
    async waitFor(o: { text?: string; selector?: string; url?: string; timeoutMs?: number }): Promise<string> {
      const ms = Math.max(300, Math.min(Number(o.timeoutMs) || 8000, 60_000));
      let body: string;
      if (o.selector) body = `await __page.waitForSelector(${json(String(o.selector))}, { timeout: ${ms}, state: "visible" });`;
      else if (o.url) body = `await __page.waitForURL(${json(String(o.url))}, { timeout: ${ms} });`;
      else if (o.text) body = `await __page.waitForFunction((t) => String((document.body && document.body.innerText) || "").includes(t), ${json(String(o.text))}, { timeout: ${ms} });`;
      else body = `await __page.waitForTimeout(${ms});`;
      const p = await run(`${body}\n${actionBody('__page')}`, ms + 15_000);
      rememberState(space, p.url, p.title);
      return `等待完成:${[o.text && `文本「${o.text}」`, o.selector && `选择器 ${o.selector}`, o.url && `URL ${o.url}`].filter(Boolean).join(' / ') || `${ms}ms`}`;
    },
    async evaluate(expression: string): Promise<string> {
      const src = String(expression || '').trim();
      if (!src) throw new Error('expression 为空');
      const p = await run(`const __v = await __page.evaluate(${json(src)}); __ok({ value: __v === undefined ? null : __v });`, 30_000);
      let out: string;
      try { out = JSON.stringify(p.value); } catch { out = String(p.value); }
      if (out === undefined) out = 'null';
      return out.length > 8000 ? out.slice(0, 8000) + '\n…(结果已截断)' : out;
    },
    async screenshot(o: { fullPage?: boolean; overlay?: boolean } = {}): Promise<Buffer> {
      const file = path.join(os.tmpdir(), `tf-ego-${crypto.randomBytes(6).toString('hex')}.png`);
      const p = await run(`
let __b64 = "";
try {
  const __r = await __page.screenshot({ path: ${json(file)}${o.fullPage ? ', fullPage: true' : ''} });
  if (__r && __r.length) __b64 = Buffer.from(__r).toString("base64");
} catch (e) {}
if (!__b64) { try { const fs = await import("node:fs"); __b64 = fs.readFileSync(${json(file)}).toString("base64"); } catch (e) {} }
__ok({ b64: __b64 });`, 60_000);
      if (!p.b64) throw new Error('ego 截图失败(页面可能还在加载)');
      return Buffer.from(String(p.b64), 'base64');
    },
    async close(): Promise<void> {
      await run(`
try { await __task.finish({ keep: [] }); } catch (e) { try { await __page.close(); } catch (e2) {} }
__ok({});`, 30_000).catch(() => { /* 关闭失败不阻塞 */ });
      refMaps.delete(space);
      lastState.delete(space);
    },
    async act(action: string, params: Record<string, any> = {}): Promise<string> {
      const a = String(action || '').toLowerCase();
      const target = params.ref || params.selector || params.text
        ? egoTarget(params.ref, params.selector, params.text, refMapOf(space))
        : '';
      switch (a) {
        case 'hover':
          await run(`await __page.hover(${json(target)}); __ok({});`, 30_000);
          return `已悬停:${short(target)}`;
        case 'dblclick':
          await run(`await __page.dblclick(${json(target)}); __ok({});`, 30_000);
          return `已双击:${short(target)}`;
        case 'select': {
          const opt = params.label != null ? json({ label: String(params.label) }) : json({ value: String(params.value ?? '') });
          await run(`await __page.selectOption(${json(target)}, ${opt}); __ok({});`, 30_000);
          return `已选择:${short(target)}`;
        }
        case 'upload':
          await run(`await __page.setInputFiles(${json(target)}, ${json(params.files || [])}); __ok({});`, 60_000);
          return `已上传到 ${short(target)}`;
        case 'text': {
          const p = await run(`__ok({ value: String(await __page.evaluate("String((document.body && document.body.innerText) || \\"\\")")) });`, 30_000);
          const t = String(p.value || '').trim();
          const max = Math.max(100, Math.min(Number(params.max) || 2000, 20_000));
          return t ? (t.length > max ? t.slice(0, max) + '\n…(已截断)' : t) : '(页面没有正文)';
        }
        case 'assert': {
          const want = String(params.text || '');
          if (!want) throw new Error('assert 需要 text');
          const p = await run(`const __b = String(await __page.evaluate("String((document.body && document.body.innerText) || \\"\\")")); __ok({ has: __b.includes(${json(want)}) });`, 30_000);
          if (!p.has) throw new Error(`断言失败:页面里没有「${want}」`);
          return `断言通过:「${want}」`;
        }
        case 'networkidle':
          await run(`await __page.waitForNetworkIdle({ timeout: ${Math.min(Number(params.timeoutMs) || 10_000, 60_000)} }).catch(() => {}); __ok({});`, 30_000);
          return '网络已空闲';
        case 'dialog':
          return 'ego(lite) 会自行处理页面弹窗;遇到需要本人操作的弹窗,agent 会停下让你接管。';
        case 'console':
          return 'ego 后端不采集历史 console;需要排查可用 browser_eval 读取页面状态或看截图。';
        case 'rightclick':
          throw new Error('ego 后端暂不支持右键(ego 的 Page API 没有暴露);可用 browser_eval 触发 contextmenu');
        default:
          throw new Error(`ego 后端不支持的动作:${action}`);
      }
    },
    async batch(steps: BatchStep[], o: { stopOnError?: boolean; snapshot?: 'always' | 'on_error' | 'never' } = {}): Promise<BatchResult> {
      const list = Array.isArray(steps) ? steps.slice(0, 60) : [];
      if (!list.length) throw new Error('steps 不能为空');
      const codes = list.map((s) => stepCode(s, space));
      const stop = o.stopOnError !== false;
      const policy = o.snapshot || 'on_error';
      const body = `
const __steps = ${json(list.map((s) => ({ op: String(s.op || '') })))};
const __results = [];
let __failedAt = null;
for (let __i = 0; __i < __steps.length; __i += 1) {
  const s = __steps[__i];
  let detail = "";
  try {
    switch (__i) {
${codes.map((c, i) => `      case ${i}: { ${c} }`).join('\n')}
      default: throw new Error("未知步骤");
    }
    __results.push({ index: __i + 1, op: s.op, ok: true, detail: String(detail || "") });
  } catch (e) {
    __results.push({ index: __i + 1, op: s.op, ok: false, detail: String((e && e.message) || e) });
    __failedAt = __i + 1;
    ${stop ? 'break;' : '/* 继续跑完 */'}
  }
}
let __snap = null;
if (${policy === 'always' ? 'true' : policy === 'on_error' ? '__failedAt !== null' : 'false'}) {
  try { __snap = await __page.snapshot(); } catch (e) { __snap = null; }
}
__ok({ results: __results, failedAt: __failedAt, url: await __page.url(), title: await __page.title(), snapshot: __snap });`;
      const p = await run(body, 180_000);
      rememberState(space, p.url, p.title);
      const out: BatchResult = {
        ok: p.failedAt === null,
        steps: Array.isArray(p.results) ? p.results : [],
        failedAt: p.failedAt ?? null,
        url: String(p.url || ''),
        title: String(p.title || '')
      };
      if (p.snapshot) {
        const snap = normalizeEgoSnapshot(String(p.snapshot));
        const map = refMapOf(space);
        map.clear();
        for (const [k, v] of snap.refs) map.set(k, v);
        out.snapshot = `页面标题:${out.title}\n地址:${out.url}\n\n页面结构(ego 语义快照):\n${snap.text}`;
      }
      return out;
    }
  };
}
