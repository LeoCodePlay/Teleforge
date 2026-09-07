// 恢复脚本4:把会话日志里 tools.ts 的读取块与 HEAD 版本对齐,定位未提交的 4 行
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const READ_RE = /^(\d+): ?(.*)$/;

function extractReads(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = Array.isArray(j) ? j : (j.events || j.log || []);
  const out = [];
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/result') continue;
    const d = ev.data || {};
    const c = typeof d.content === 'string' ? d.content : '';
    if (!c.includes('<path>')) continue;
    const mPath = /<path>([^<]+)<\/path>/.exec(c);
    if (!mPath || !/tools\.ts$/i.test(mPath[1].trim())) continue;
    const body = /<content>\n([\s\S]*?)\n<\/content>/.exec(c);
    if (!body) continue;
    const lines = [];
    let trunc = false;
    for (const ln of body[1].split('\n')) {
      const m = READ_RE.exec(ln);
      if (m) {
        if (/\(line truncated to \d+ chars\)/.test(m[2])) trunc = true;
        lines.push({ n: Number(m[1]), t: m[2] });
      }
    }
    out.push({ time: ev.time, lines, trunc });
  }
  return out;
}

// HEAD 内容(磁盘 CRLF → LF)
const headRaw = fs.readFileSync(path.join(root, 'server/agent/tools.ts'), 'utf8').replace(/\r\n/g, '\n');
const head = headRaw.split('\n'); // head[0] = 第 1 行

const reads = extractReads(path.join(root, 'data/sessions/s_mtqszgm65q8u3d.json'));
console.log('reads found:', reads.length);
for (const r of reads) {
  const from = r.lines[0].n, to = r.lines[r.lines.length - 1].n;
  // 穷举 shift,找最佳对齐
  let best = { shift: null, match: -1, mism: [] };
  for (let shift = -8; shift <= 8; shift++) {
    let match = 0; const mism = [];
    for (const l of r.lines) {
      const h = head[l.n - 1 + shift];
      if (h === undefined) continue;
      if (h === l.t) match++;
      else mism.push({ n: l.n, disk: l.t, head: h });
    }
    if (match > best.match) best = { shift, match, mism };
  }
  const total = r.lines.length;
  console.log(`chunk ${from}-${to}: bestShift=${best.shift} match=${best.match}/${total}` + (r.trunc ? ' HAS-TRUNCATED' : ''));
  for (const m of best.mism.slice(0, 12)) {
    console.log(`  disk ${m.n}: ${JSON.stringify(m.disk.slice(0, 120))}`);
    console.log(`  head ${m.n + best.shift}: ${JSON.stringify(m.head.slice(0, 120))}`);
  }
}
