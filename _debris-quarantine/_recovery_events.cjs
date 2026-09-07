// 恢复脚本2:列出会话日志中所有提及 tools.ts 的事件(工具调用参数/结果/编辑等)
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const files = process.argv.slice(3);

for (const f of files) {
  const p = path.isAbsolute(f) ? f : path.join(root, f);
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.log(f, 'ERR', e.message); continue; }
  const events = Array.isArray(j) ? j : (j.events || j.log || []);
  console.log('=== ' + path.basename(p) + ' (' + events.length + ' events) ===');
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const d = ev.data || {};
    let blob = '';
    try { blob = JSON.stringify(d); } catch { continue; }
    if (!blob.includes('tools.ts')) continue;
    const t = new Date(ev.time).toISOString().slice(11, 19);
    if (ev.type === 'tool/call' || ev.type === 'tool_call') {
      let args = d.arguments;
      try { args = JSON.stringify(JSON.parse(d.arguments), null, 1); } catch {}
      console.log(`--- ${t} ${ev.type} ${d.name} seq=${ev.seq}`);
      console.log(String(args).slice(0, 1600));
    } else if (ev.type === 'tool/result' || ev.type === 'tool_result') {
      const c = String(d.content || '');
      console.log(`--- ${t} ${ev.type} ${d.name} isError=${d.isError} seq=${ev.seq}`);
      console.log(c.slice(0, 900));
    } else {
      console.log(`--- ${t} ${ev.type} seq=${ev.seq}`);
      console.log(blob.slice(0, 500));
    }
  }
}
