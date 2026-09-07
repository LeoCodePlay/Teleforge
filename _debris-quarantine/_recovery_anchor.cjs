// 恢复脚本7:用已知的 (disk行号, 内容) 锚点对照 HEAD,推断每段区域的插入偏移
const fs = require('fs');
const head = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n').split('\n');

// 锚点:[disk行号, 行内容前缀](来自会话日志/上下文中的搜索命中,均为截断前磁盘行号)
const anchors = [
  [319, '// meta:结构化终端卡数据(命令/工作目录/退出码/信号/超时)'],
  [587, '// meta:结构化来源列表,供前端 WebSearchRow 卡片忠实呈现'],
  [588, "return { content: renderSearchResult(outcome), meta: { card: 'web_search'"],
  [729, "meta: { card: 'terminal', command, cwd: localFs.workspace || ''"],
  [649, "throw new Error('文件超过 2MB,不适宜逐文本编辑"],
  [882, 'function splitFrontmatter(text: string)'],
  [884, "if (!m) return { meta: {}, body: text };"],
  [885, 'const meta: Record<string, any> = {};'],
  [888, "if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()"],
  [890, 'return { meta, body: m[2] };'],
  [931, 'const { meta, body } = splitFrontmatter(text);'],
  [932, "const name = String(meta.name || fallbackName || '')"],
  [933, 'const descRaw = String(meta.description || body.split'],
  [1494, 'skip = {".git", "node_modules", "__pycache__"'],
  [127, "'.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',"],
  [696, '// 与远程 search_code 对齐:排除 .git/node_modules/dist 等噪声目录,'],
];

for (const [diskN, prefix] of anchors) {
  let found = null;
  for (let off = -6; off <= 6; off++) {
    const h = head[diskN - 1 + off];
    if (h !== undefined && h.includes(prefix)) { found = off; break; }
  }
  console.log(`disk ${diskN}  ->  HEAD offset ${found === null ? 'NOT FOUND' : found}  (HEAD line ${found === null ? '?' : diskN + found})  | ${prefix.slice(0, 40)}`);
}
