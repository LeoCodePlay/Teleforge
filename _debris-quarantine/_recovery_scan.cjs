// 临时诊断脚本:在会话日志 JSON 里查找 tools.ts 的内容快照(用于截断恢复)
const fs = require('fs');
const path = require('path');
const root = process.argv[2] || process.cwd();
const cands = [];
let errors = 0;
function walk(d, depth) {
  if (depth > 3) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|^\.git$|^\.gstack|^\.superpowers|^\.playwright/i.test(e.name)) walk(p, depth + 1);
    } else if (e.isFile() && /\.json$/i.test(e.name)) {
      const st = fs.statSync(p);
      if (st.size > 30000) cands.push({ p, size: st.size, mtime: st.mtimeMs });
    }
  }
}
walk(root, 0);
cands.sort((a, b) => b.mtime - a.mtime);
console.log('candidates:', cands.length);
const hits = [];
for (const c of cands) {
  try {
    const s = fs.readFileSync(c.p, 'utf8');
    const n = (s.match(/tools\.ts/g) || []).length;
    if (n > 0) hits.push({ f: path.relative(root, c.p), m: new Date(c.mtime).toISOString().slice(0, 16), n });
  } catch { errors++; }
}
for (const h of hits.slice(0, 25)) console.log(h.m, h.n, h.f);
console.log('readErrors:', errors);
