// 对多个真实窗口跑 uia_tree / uia_find,看错误与耗时(验证 ∞ 坐标崩溃是否真实存在)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { WORKER_PS1 } = await import('../server/core/computer-use/ps-scripts.ts');
const dir = path.join(os.tmpdir(), 'tf-cu-bench');
fs.mkdirSync(dir, { recursive: true });
const script = path.join(dir, 'worker.ps1');
fs.writeFileSync(script, '\ufeff' + WORKER_PS1, 'utf8');

const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'inherit']
});
proc.stdout.setEncoding('utf8');
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
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});
function call(op, params = {}, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + op)); }, timeout);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
  });
}

await call('ping');
const wins = await call('windows');
const list = (wins.windows || []).filter((w) => w.w > 400 && w.h > 300).slice(0, 8);
for (const w of list) {
  const t = Date.now();
  let r;
  try { r = await call('uia_tree', { hwnd: w.hwnd, max_depth: 6, max_nodes: 120, interactive_only: true }); } catch (e) { r = { ok: false, error: 'TIMEOUT ' + e.message }; }
  const ms = Date.now() - t;
  const size = Buffer.byteLength(JSON.stringify(r));
  const txt = (r.nodes || []).map((n) => n.name).join('|');
  console.log(`${w.process.padEnd(16)} hwnd=${String(w.hwnd).padEnd(9)} ${String(ms).padStart(5)}ms ok=${r.ok !== false} nodes=${r.count ?? '-'} json=${size}B ${r.ok === false ? 'ERR=' + String(r.error).slice(0, 80) : ''}`);
  const t2 = Date.now();
  let f;
  try { f = await call('uia_find', { hwnd: w.hwnd, query: '文件', limit: 8 }); } catch (e) { f = { ok: false, error: 'TIMEOUT' }; }
  console.log(`  find: ${Date.now() - t2}ms ok=${f.ok !== false} scanned=${f.scanned ?? '-'} hits=${f.count ?? '-'} ${f.ok === false ? 'ERR=' + String(f.error).slice(0, 60) : ''}`);
  void txt;
}
proc.kill();
process.exit(0);
