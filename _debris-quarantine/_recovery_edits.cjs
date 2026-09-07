// 恢复脚本6:全量扫描会话日志,找所有针对 tools.ts 的写/编辑工具调用
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const found = [];

function scanFile(p) {
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return; }
  const events = Array.isArray(j) ? j : (j.events || j.log || j.messages || []);
  if (!Array.isArray(events)) return;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const d = ev.data || ev;
    // tool/call 事件
    if ((ev.type === 'tool/call' || ev.type === 'tool_call') && d.arguments) {
      if (String(d.arguments).includes('tools.ts') && /edit_local_file|write_local_file|edit_file|write_file/.test(d.name || '')) {
        found.push({ file: p, time: ev.time, type: ev.type, name: d.name, args: String(d.arguments) });
      }
    }
    // assistant 消息内嵌 tool_calls(旧格式)
    const msg = d.message || d;
    if (msg && msg.tool_calls) {
      for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
        const fn = tc.function || {};
        if (String(fn.arguments || '').includes('tools.ts') && /edit_local_file|write_local_file|edit_file|write_file/.test(fn.name || '')) {
          found.push({ file: p, time: ev.time, type: 'embedded_tool_calls', name: fn.name, args: String(fn.arguments) });
        }
      }
    }
  }
}

function walk(d, depth) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|^\.git$|^\.gstack$|^\.superpowers$|^\.playwright/i.test(e.name)) walk(p, depth + 1);
    } else if (e.isFile() && /\.json$/i.test(e.name)) {
      scanFile(p);
    }
  }
}
walk(root, 0);
found.sort((a, b) => (a.time || 0) - (b.time || 0));
console.log('total edit-calls on tools.ts:', found.length);
for (const f of found) {
  console.log('=== ' + new Date(f.time || 0).toISOString() + ' ' + path.basename(f.file) + ' ' + f.name);
  console.log(f.args.slice(0, 700).replace(/\\n/g, '\n').slice(0, 700));
}
