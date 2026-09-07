// 恢复脚本3:提取指定 seq 事件的完整 content
const fs = require('fs');
const p = process.argv[2];
const seqs = process.argv.slice(3).map(Number);
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const events = Array.isArray(j) ? j : (j.events || j.log || []);
for (const ev of events) {
  if (!seqs.includes(Number(ev.seq))) continue;
  const d = ev.data || {};
  console.log('=== seq=' + ev.seq + ' type=' + ev.type + ' time=' + new Date(ev.time).toISOString());
  const c = String(d.content || d.arguments || '');
  console.log(c);
}
