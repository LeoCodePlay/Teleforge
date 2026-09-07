// 恢复脚本:从 data/sessions/*.json 的 tool/result(read 输出)里解析 tools.ts 行快照
// 输出:每个会话文件对 tools.ts 的行覆盖区间与最新读取时间,便于拼合完整文件
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const files = process.argv.slice(3);
const READ_RE = /^(\d+): ?(.*)$/;

function extractReads(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  const events = Array.isArray(j) ? j : (j.events || j.log || []);
  const out = [];
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/result') continue;
    const d = ev.data || {};
    const c = typeof d.content === 'string' ? d.content : '';
    if (!c.includes('<path>') || !/tools\.ts/i.test(c.slice(0, 400))) continue;
    const mPath = /<path>([^<]+)<\/path>/.exec(c);
    if (!mPath) continue;
    if (!/tools\.ts$/i.test(mPath[1].trim())) continue;
    const body = /<content>\n([\s\S]*?)\n<\/content>/.exec(c);
    if (!body) continue;
    const lines = [];
    let truncatedLine = false;
    for (const ln of body[1].split('\n')) {
      const m = READ_RE.exec(ln);
      if (m) {
        if (/\(line truncated to \d+ chars\)/.test(m[2])) truncatedLine = true;
        lines.push({ n: Number(m[1]), t: m[2] });
      }
    }
    const footer = /\((?:Showing lines (\d+)-(\d+) of (\d+)[^)]*|End of file - total (\d+) lines)\)/.exec(c);
    out.push({
      time: ev.time, tool: d.name,
      path: mPath[1].trim(),
      from: lines.length ? lines[0].n : null,
      to: lines.length ? lines[lines.length - 1].n : null,
      total: footer ? Number(footer[3] || footer[4]) : null,
      lines, truncatedLine
    });
  }
  return out;
}

for (const f of files) {
  const p = path.isAbsolute(f) ? f : path.join(root, f);
  let reads;
  try { reads = extractReads(p); } catch (e) { console.log(path.basename(p), 'ERROR', e.message); continue; }
  if (!reads.length) { console.log(path.basename(p), 'no tools.ts reads'); continue; }
  console.log('=== ' + path.basename(p) + ' ===');
  for (const r of reads) {
    console.log('  ' + new Date(r.time).toISOString() + ' ' + r.tool + ' lines ' + r.from + '-' + r.to +
      (r.total ? '/' + r.total : '') + ' (' + r.lines.length + ' rows' + (r.truncatedLine ? ', HAS-TRUNCATED-LINE' : '') + ')');
  }
}
