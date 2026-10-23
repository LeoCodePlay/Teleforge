// 设计规范自动检查(见 web/DESIGN_SYSTEM.md)。
//
// 只检查能机械判定的硬规则,避免变成第二个「靠人眼维护」的文档:
//   1. 未定义 token:var(--bg) / var(--bg-elev) 这类明显写错的变量
//   2. backdrop-filter 只允许 none 或 var(...)(dsh 的 token 解析为 none)
//   3. 禁止 text-shadow / drop-shadow / 0 0 Npx 外发光
//   4. 禁止 rgba(0,0,0,...) 纯黑遮罩/投影
//   5. mask-image 之外的硬编码 #000
//   6. 圆角只允许 token、50%、999px、0 和 1–5px 微圆角;6px 及以上必须是 token
//
// 用法:
//   node scripts/check-design.mjs
//   npm run check:design
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = path.join(root, 'web', 'src');
const styleExts = new Set(['.scss', '.css']);
const allExts = new Set(['.scss', '.css', '.ts', '.tsx']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (allExts.has(path.extname(entry.name))) files.push(full);
  }
}

function stripComments(text) {
  let out = '';
  let i = 0;
  let block = false;
  while (i < text.length) {
    if (!block && text.startsWith('/*', i)) {
      block = true;
      i += 2;
      continue;
    }
    if (block && text.startsWith('*/', i)) {
      block = false;
      i += 2;
      continue;
    }
    if (block) {
      if (text[i] === '\n') out += '\n';
      i += 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

const problems = [];

function check(file, lineNo, message) {
  problems.push(`${path.relative(root, file)}:${lineNo} ${message}`);
}

function checkLine(file, lineNo, line, isStyle) {
  if (/\bvar\(--bg(?:\s*,|\s*\))/.test(line) || /--bg-elev/.test(line)) {
    check(file, lineNo, '未定义 token: --bg / --bg-elev 不存在,请用 --bg-deep / --overlay-bg');
  }

  if (!isStyle) return;

  const backdrop = line.match(/(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)/);
  if (backdrop && !/^(none|var\()/.test(backdrop[1].trim())) {
    check(file, lineNo, `禁止 backdrop-filter: ${backdrop[1].trim()}`);
  }

  const textShadow = line.match(/text-shadow\s*:\s*([^;]+)/);
  if (textShadow && !/^none\b/.test(textShadow[1].trim())) {
    check(file, lineNo, '禁止 text-shadow 光晕');
  }

  const filter = line.match(/(?:^|[;{\s])filter\s*:\s*([^;]+)/);
  if (filter && /drop-shadow\(/.test(filter[1])) {
    check(file, lineNo, '禁止 filter: drop-shadow 外发光');
  }

  const boxShadow = line.match(/box-shadow\s*:\s*([^;]+)/);
  if (boxShadow) {
    for (const part of boxShadow[1].split(',')) {
      const nums = part.trim().split(/\s+/).filter((t) => /^-?(?:\d+|\d*\.\d+)(?:px)?$/.test(t));
      if (nums.length >= 3 && nums[0] === '0' && nums[1] === '0' && parseFloat(nums[2]) > 0) {
        check(file, lineNo, '禁止 0 0 Npx 外发光');
        break;
      }
    }
  }

  if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\b/.test(line)) {
    check(file, lineNo, '禁止 rgba(0,0,0,...) 纯黑遮罩/投影,请用 --mask-bg / --glass-shadow*');
  }

  if (/#000(?:000)?\b/i.test(line) && !/mask|data:image|stroke=/.test(line)) {
    check(file, lineNo, 'mask-image 之外不要硬编码 #000');
  }

  const radius = line.match(/border-radius\s*:\s*([^;]+)/);
  if (radius) {
    const value = radius[1].replace(/var\([^)]*\)/g, '');
    const bare = value.replace(/50%|999px/g, '');
    if (/\b(?:[6-9]|[1-9]\d+)px\b/.test(bare)) {
      check(file, lineNo, `圆角裸值: ${radius[1].trim()}(6px 及以上必须用 --r-sm/md/lg)`);
    }
  }

  const fontSize = line.match(/font-size\s*:\s*([^;]+)/);
  if (fontSize) {
    // calc() 里的 1px 是光学微调，不是字号档位。
    const rawFont = fontSize[1].replace(/\b1px\b/g, '');
    if (/\b\d+(?:\.\d+)?px\b/.test(rawFont)) {
      // BottomBar 的 20px 是图标字形，不是文案字号；其余裸字号一律视为回归。
      if (!(path.basename(file) === 'BottomBar.scss' && fontSize[1].includes('20px'))) {
        check(file, lineNo, `字号裸值: ${fontSize[1].trim()}(请用 --fs-*)`);
      }
    }
  }

  const spacing = line.match(/(?<![\w-])(gap|row-gap|column-gap|margin|margin-top|margin-right|margin-bottom|margin-left|padding|padding-top|padding-right|padding-bottom|padding-left)\s*:\s*([^;}]+)/);
  if (spacing && /(?<!-)\b(2|4|6|8|10|12|14|16|20|24|32)px\b/.test(spacing[2])) {
    check(file, lineNo, `间距裸值: ${spacing[1]}: ${spacing[2].trim()}(请用 --space-*)`);
  }
}

walk(webSrc);
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file);
  const clean = stripComments(raw).split('\n').map((line) => (
    ext === '.scss' || ext === '.ts' || ext === '.tsx'
      ? line.replace(/\/\/.*$/, '')
      : line
  )).join('\n');
  const lines = clean.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    checkLine(file, i + 1, lines[i], styleExts.has(ext));
  }
}

if (problems.length > 0) {
  console.error(`设计规范检查失败(${problems.length} 处):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`设计规范检查通过:${files.length} 个文件`);
}
