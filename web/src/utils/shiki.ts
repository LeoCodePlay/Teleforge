// Shiki 高亮器的**懒加载单例**(与 dsh 一样用 Shiki,但按 Teleforge 的现状裁剪):
//   - 双主题同时算一次(light/dark),token 上带 `--shiki-dark`;由 CSS 按 data-dark 选哪个色,
//     所以**切主题不需要重新高亮**(重新高亮要等 worker 返回,会让对比面板闪一下);
//   - 语言按需注册:只有用户真的看某个文件时才加载对应语法,不把 30 种语言打进首屏;
//   - 任何失败(未装的语言、shiki 加载失败)都返回 null,调用方回落纯文本 ——
//     代码高亮是装饰,绝不能让「看变更」这件事不成立。
import { createHighlighter, type Highlighter } from 'shiki';

/** 内置主题:与 dsh 的观感同族(GitHub 亮/暗),不跟随应用强调色(代码配色不该被主题带跑) */
const THEME_LIGHT = 'github-light-default';
const THEME_DARK = 'github-dark-default';

/** 支持的语言(与 FileViewer 已支持的扩展名基本对齐,避免同一个文件两处高亮不一致) */
const LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx', 'json', 'html', 'css', 'scss', 'markdown',
  'yaml', 'xml', 'python', 'rust', 'go', 'java', 'kotlin', 'csharp', 'php', 'cpp', 'c',
  'sql', 'bash', 'diff', 'toml', 'ini', 'dockerfile', 'vue', 'svelte', 'ruby', 'swift',
  'lua', 'perl', 'r', 'graphql', 'make', 'nginx', 'powershell', 'objective-c'
] as const;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html',
  css: 'css',
  scss: 'scss', sass: 'scss', less: 'css',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', svg: 'xml', plist: 'xml',
  py: 'python', pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp',
  php: 'php',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  c: 'c', h: 'c',
  sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash',
  diff: 'diff', patch: 'diff',
  toml: 'toml',
  ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
  vue: 'vue',
  svelte: 'svelte',
  rb: 'ruby',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r',
  graphql: 'graphql', gql: 'graphql',
  nginx: 'nginx',
  ps1: 'powershell',
  m: 'objective-c', mm: 'objective-c',
};

/** 特殊文件名 → 语言 */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  '.gitignore': 'ini',
  '.env': 'ini',
  '.editorconfig': 'ini',
};

/** 按路径猜语言;认不出来的返回 'text'(调用方会跳过高亮) */
export function langForPath(path: string): string {
  const base = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const byName = NAME_LANG[base.toLowerCase()];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'text';
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] || 'text';
}

let pending: Promise<Highlighter | null> | null = null;

/** 取(或首次创建)高亮器;失败返回 null 并由调用方回落纯文本 */
export function getHighlighter(): Promise<Highlighter | null> {
  if (!pending) {
    pending = createHighlighter({
      themes: [THEME_LIGHT, THEME_DARK],
      langs: [...LANGS]
    }).catch(() => null);
  }
  return pending;
}

/** 一段高亮出来的文字片段(style 里含 color 与 --shiki-dark) */
export interface HighlightSpan {
  text: string;
  style?: Record<string, string>;
}

/**
 * 把一段代码按行高亮(双主题一次算完)。返回 null = 不高亮(调用方渲染纯文本)。
 * @param code 代码(行之间用 \n 连接,末尾不加换行 —— 否则 shiki 会多出一行空行,行号错位)
 * @param lang 语言 id;'text' / 未注册语言直接返回 null
 */
export async function highlightLines(code: string, lang: string): Promise<HighlightSpan[][] | null> {
  if (!code || !lang || lang === 'text') return null;
  try {
    const hl = await getHighlighter();
    if (!hl || !hl.getLoadedLanguages().includes(lang)) return null;
    const out = hl.codeToTokens(code, {
      // 语言 id 来自 langForPath 的白名单,并已用 getLoadedLanguages() 校验过;
      // shiki 的类型是「已内置语言」的字面量联合,收敛不到 string,这里在边界处放行一次
      lang: lang as never,
      themes: { light: THEME_LIGHT, dark: THEME_DARK }
    });
    return out.tokens.map((line) => line.map((t) => ({
      text: t.content,
      style: (t as { htmlStyle?: Record<string, string> }).htmlStyle
    })));
  } catch {
    return null;
  }
}
