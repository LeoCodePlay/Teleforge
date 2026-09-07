// 恢复脚本5:在所有编辑器 Local History 中模糊搜索 tools.ts 相关快照
const fs = require('fs');
const path = require('path');
const roots = [
  'C:/Users/30653/AppData/Roaming/Trae/User/History',
  'C:/Users/30653/AppData/Roaming/Trae CN/User/History',
  'C:/Users/30653/AppData/Roaming/Code/User/History',
  'C:/Users/30653/AppData/Roaming/Cursor/User/History',
  'C:/Users/30653/AppData/Roaming/TRAE SOLO CN/User/History'
];
const hits = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { continue; }
  for (const dir of dirs) {
    const ej = path.join(root, dir, 'entries.json');
    let raw;
    try { raw = fs.readFileSync(ej, 'utf8'); } catch { continue; }
    if (!raw.toLowerCase().includes('tools.ts')) continue;
    let res = '';
    try { res = decodeURIComponent((JSON.parse(raw).resource || '')); } catch { res = (/"resource"\s*:\s*"([^"]+)"/.exec(raw) || [])[1] || '?'; }
    hits.push({ root: path.basename(path.dirname(path.dirname(root))), dir, res });
  }
}
console.log('hits:', hits.length);
for (const h of hits) console.log(h.root, h.dir, h.res);
