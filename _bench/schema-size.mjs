// 统计 computer_* 工具 schema 的体积(模型每次请求都要付这部分 token)
import fs from 'node:fs';
const mod = await import('../server/agent/computer-use-tools.ts');
const tools = mod.computerUseToolDefs;
let total = 0;
const rows = [];
for (const t of tools) {
  const schema = { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } };
  const s = JSON.stringify(schema);
  total += s.length;
  rows.push([t.name, s.length, (t.description || '').length, JSON.stringify(t.parameters || {}).length]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const r of rows) console.log(`${r[0].padEnd(20)} json=${String(r[1]).padStart(5)}B  desc=${String(r[2]).padStart(5)}  params=${String(r[3]).padStart(5)}`);
console.log(`\n合计 ${total}B ≈ ${Math.round(total / 1.6)} tokens(中文按 ~1.6B/token 粗估)`);
