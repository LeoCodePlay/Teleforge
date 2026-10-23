// 假 `ego-browser`(仅测试用):实现 `ego-browser nodejs` 的脚本执行契约。
//
// 它不做真实浏览器操作,只维护一份 JSON 状态(url/title/元素/输入值/点击记录),
// 用来验证 Teleforge 侧"生成脚本 → 喂 stdin → 解析 __TF__ 结果 → 映射 ref"这条链路。
// 状态文件由 FAKE_EGO_STATE 指定,跨进程保留(正好模拟 ego 的 Space/Page 持久化)。
import fs from 'node:fs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const stateFile = String(process.env.FAKE_EGO_STATE || '');
const DEFAULT_ELEMENTS = [
  { role: 'button', name: '提交', sel: '#submit', depth: 0 },
  { role: 'textbox', name: '姓名', sel: '#name', depth: 0 },
  { role: 'button', name: '取消', sel: '#cancel', depth: 1 },
  { role: 'link', name: '不稳定链接', sel: '', unstable: true }
];

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch { /* 首次运行 */ }
  return { url: '', title: '', elements: DEFAULT_ELEMENTS.slice(), value: '', clicks: [], calls: [], spaces: [] };
}
function save(s) {
  if (!stateFile) return;
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch { /* 忽略 */ }
}

const state = load();
if (!state.elements || !state.elements.length) state.elements = DEFAULT_ELEMENTS.slice();

async function resolveTarget(t) {
  const target = String(t || '');
  state.calls.push(target);
  if (target.startsWith('loc=css:')) {
    const sel = target.slice('loc=css:'.length);
    const hit = state.elements.find((e) => e.sel === sel);
    if (!hit) throw new Error(`没找到元素:${target}`);
    return hit;
  }
  if (target.startsWith('text=')) {
    const txt = target.slice(5);
    const hit = state.elements.find((e) => String(e.name).includes(txt));
    if (!hit) throw new Error(`没找到文本元素:${target}`);
    return hit;
  }
  if (target.startsWith('@') || /^\d+$/.test(target)) return { name: target, sel: '' };
  // 裸 CSS 选择器(真 ego 支持,假实现按 #id 匹配)
  if (/^[#.[a-z]/i.test(target)) {
    const hit = state.elements.find((e) => e.sel === target)
      || state.elements.find((e) => e.sel && target.includes(e.sel.replace(/^[#.]/, '')));
    if (hit) return hit;
    throw new Error(`没找到元素:${target}`);
  }
  throw new Error(`不支持的定位方式:${target}`);
}

const page = {
  url: async () => state.url,
  title: async () => state.title,
  goto: async (u) => {
    state.url = String(u);
    try { state.title = '假页面:' + new URL(state.url).host; } catch { state.title = '假页面'; }
    save(state);
  },
  waitForLoadState: async () => {},
  waitForTimeout: async () => {},
  waitForSelector: async () => {},
  waitForURL: async () => {},
  waitForFunction: async () => {},
  waitForNetworkIdle: async () => {},
  snapshot: async () => state.elements
    .map((e, i) => `${'  '.repeat(e.depth || 0)}${e.role} "${e.name}" [ref=${i + 1}, loc=${e.unstable ? 'unstable' : `css:${e.sel}`}]`)
    .join('\n'),
  click: async (t) => { const el = await resolveTarget(t); state.clicks.push({ target: String(t), name: el.name }); save(state); },
  dblclick: async (t) => { await resolveTarget(t); state.clicks.push({ target: String(t), dbl: true }); save(state); },
  hover: async (t) => { await resolveTarget(t); state.hovered = String(t); save(state); },
  fill: async (t, v) => { await resolveTarget(t); state.value = String(v); save(state); },
  press: async (k) => { state.key = String(k); save(state); },
  keyboard: { press: async (k) => { state.key = String(k); save(state); } },
  selectOption: async (t, o) => { await resolveTarget(t); state.selected = o; save(state); },
  setInputFiles: async (t, files) => { await resolveTarget(t); state.files = files; save(state); },
  evaluate: async (expr) => {
    const s = String(expr);
    if (s.includes('innerText')) return state.text || '正文内容';
    if (s.includes('scrollBy')) return 0;
    return null;
  },
  screenshot: async (opts = {}) => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    if (opts && opts.path) { try { fs.writeFileSync(opts.path, buf); } catch { /* 忽略 */ } }
    return buf;
  },
  close: async () => { state.closed = true; save(state); }
};

const task = {
  spaceId: 1,
  name: state.spaces[state.spaces.length - 1] || 'fake',
  pages: async () => [page],
  page: () => page,
  newPage: async () => page,
  finish: async () => { state.finished = true; save(state); }
};

const taskSpace = async (name) => {
  if (!state.spaces.includes(name)) state.spaces.push(name);
  state.space = name;
  save(state);
  return task;
};
const listTaskSpaces = async () => state.spaces.map((name, i) => ({ id: i + 1, name, ownership: 'agent' }));
const useOrCreateTaskSpace = taskSpace;

// 读完整段脚本(与真 CLI 一样从 stdin 收)
let code = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) code += chunk;

try {
  const fn = new AsyncFunction('taskSpace', 'listTaskSpaces', 'useOrCreateTaskSpace', 'console', code);
  await fn(taskSpace, listTaskSpaces, useOrCreateTaskSpace, console);
} catch (e) {
  process.stderr.write(`fake-ego error: ${(e && e.stack) || e}\n`);
  process.exitCode = 1;
}
