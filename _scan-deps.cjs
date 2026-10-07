// 一次性扫描脚本:列出某个 dsh 包源码里的**外部依赖面**(非相对 import)。
// 用法:node _scan-deps.cjs web/src/dsh/ui-sidebar-documentpreview
const fs = require('fs');
const root = process.argv[2];
const dirs = [root, root + '/client', root + '/src'];
const seen = new Set();
const names = [];
function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const q = d + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'lib') walk(q); continue; }
    if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
    const text = fs.readFileSync(q, 'utf8');
    for (const m of text.matchAll(/from\s*['"]([^'".][^'"]*)['"]/g)) {
      if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
    }
  }
}
for (const d of dirs) walk(d);
console.log(names.sort().join('\n'));
