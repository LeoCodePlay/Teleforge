// 临时基准:直接驱动 WORKER_PS1,测量每个 op 的往返延迟与返回 JSON 体积。
// 只做只读探测(windows / ui / ocr / capture),不移动鼠标、不点击。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { WORKER_PS1 } = await import('../server/core/computer-use/ps-scripts.ts');

const dir = path.join(os.tmpdir(), 'tf-cu-bench');
fs.mkdirSync(dir, { recursive: true });
const script = path.join(dir, 'worker.ps1');
fs.writeFileSync(script, '\ufeff' + WORKER_PS1, 'utf8');

const t0 = Date.now();
const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (d) => process.stderr.write('[ps] ' + d));

let buf = '';
const pending = new Map();
let seq = 0;
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});

function call(op, params = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + op)); }, timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
  });
}

async function time(label, fn, repeat = 3) {
  const rows = [];
  let last;
  for (let i = 0; i < repeat; i++) {
    const t = Date.now();
    last = await fn();
    rows.push(Date.now() - t);
  }
  const best = Math.min(...rows);
  const bytes = Buffer.byteLength(JSON.stringify(last));
  console.log(`${label.padEnd(28)} best=${String(best).padStart(5)}ms  all=[${rows.join(',')}]ms  json=${bytes}B`);
  return last;
}

const start = Date.now();
const ping = await call('ping', {}, 60000);
console.log(`cold start (spawn + Add-Type + ping): ${Date.now() - start}ms (pid=${ping.pid})`);

await time('ping(warm)', () => call('ping'));
const mons = await time('monitors', () => call('monitors'));
const wins = await time('windows', () => call('windows'));
const fg = wins.foreground;

// window_rect:分别测 hwnd(当前实现走 Find-RootWindow 全量枚举)与 title
const big = (wins.windows || []).filter((w) => w.w > 300 && w.h > 200).slice(0, 2);
for (const w of big) {
  await time(`window_rect hwnd=${w.hwnd}`, () => call('window_rect', { hwnd: w.hwnd }));
}
await time('element_at (cursor)', () => call('element_at', { x: mons.cursor.x, y: mons.cursor.y }));

const target = big[0] || (wins.windows || [])[0];
if (target) {
  await time('uia_tree hwnd (120 nodes)', () => call('uia_tree', { hwnd: target.hwnd, max_depth: 6, max_nodes: 120, interactive_only: true }), 2);
  await time('uia_tree hwnd (30 nodes)', () => call('uia_tree', { hwnd: target.hwnd, max_depth: 6, max_nodes: 30, interactive_only: true }), 2);
  await time('uia_find (miss)', () => call('uia_find', { hwnd: target.hwnd, query: '__不存在的控件名__', limit: 3 }), 2);
  await time('uia_find (hit: 文件)', () => call('uia_find', { hwnd: target.hwnd, query: '文件', limit: 10 }), 2);
  const shot = await time('capture (fg monitor)', () => call('capture', { path: path.join(dir, 'shot.jpg') }), 2);
  console.log(`  capture: ${shot.width}x${shot.height} scale=${shot.scale} jpg=${fs.statSync(path.join(dir, 'shot.jpg')).size}B`);
  await time('ocr hwnd scale=2', () => call('ocr', { path: path.join(dir, 'ocr.png'), hwnd: target.hwnd, scale: 2 }), 2);
  await time('ocr hwnd scale=1', () => call('ocr', { path: path.join(dir, 'ocr1.png'), hwnd: target.hwnd, scale: 1 }), 2);
}

proc.kill();
console.log('\nforeground:', JSON.stringify(fg), 'monitors:', JSON.stringify(mons.monitors));
process.exit(0);
