// @引用 的序列化 / 展示 / 还原(纯函数,无 DOM 依赖,可单测)。
//
// 输入框里用户看到并编辑的始终是 @文件名;发送时前端把它替换成 @source:完整路径
// (source = remote|local + 绝对路径),让模型能按路径用工具读取、服务端据此把图片引用
// 补成附件(见 server/agent/mention-refs.ts)。于是同一条消息有两个形态:
//   - 上行正文(发给模型 / 落盘历史):@remote:/w/a.ts  —— 路径必须保留
//   - 界面展示(消息气泡 / 待执行队列):@a.ts         —— 路径是噪音,只留文件名
// 本模块负责两态互转。路径含空白时序列化成 @remote:"/w/a b.ts"(加引号):
// 纯文本里没有别的办法确定路径终点,而路径又必须完整交给模型。
// 老历史里(本次改动之前落盘的)含空白路径没有引号,折叠时只能取到第一个空白之前的部分
// —— 那部分路径本来就没法在纯文本里还原,只影响老消息的展示,新消息一律带引号。
//
// 另附 atTokenAt:按「光标位置」定位输入框里正在编辑的 @词。
// 过去只在整条输入以 @词 结尾时才弹菜单,于是「在已有文字中间插入引用」永远弹不出来
// (@ 后面还跟着别的内容就不算结尾)。

export type MentionSource = 'remote' | 'local';

export interface MentionRef {
  source: MentionSource;
  path: string;
}

/** 上行正文里的引用形态:@source:path / @source:"path with spaces" */
const SERIALIZED_RE = /(^|\s)@(remote|local):(?:"([^"\n]*)"|([^\s]*))/g;

/** 输入框里 @词 允许出现的字符(与 tokenizeInput / 菜单过滤口径一致) */
const AT_TOKEN_RE = /(?:^|\s)@([a-zA-Z0-9_.\-/\\]*)$/;

/** 取路径末段(文件名/文件夹名),兼容 / 与 \ 分隔,忽略末尾分隔符 */
export function mentionBaseName(p: string): string {
  const t = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

/** 序列化一条引用:路径含空白(或引号)时用双引号包住,保证展示侧能解析出终点 */
export function serializeMention(source: MentionSource, path: string): string {
  const p = String(path ?? '');
  return /[\s"]/.test(p) ? `@${source}:"${p}"` : `@${source}:${p}`;
}

export type MentionSeg =
  | { t: 'text'; v: string }
  | { t: 'mention'; v: string; name: string; source: MentionSource; path: string };

/** 把正文切成「文本 / @引用」段:引用统一折叠成 @文件名 */
export function splitMentions(text: string): MentionSeg[] {
  const src = String(text ?? '');
  const out: MentionSeg[] = [];
  const re = new RegExp(SERIALIZED_RE.source, 'g'); // 每次新建,避免共享 lastIndex
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const path = m[3] != null ? m[3] : m[4];
    if (!path) continue; // @remote: 后直接空白 = 不是引用,原样留作文本
    const start = m.index + m[1].length;
    if (start > last) out.push({ t: 'text', v: src.slice(last, start) });
    const source: MentionSource = m[2] === 'remote' ? 'remote' : 'local';
    const name = mentionBaseName(path);
    out.push({ t: 'mention', v: `@${name}`, name, source, path });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

/** 展示态纯文本:路径折叠成 @文件名(复制、队列、跳转点提示用) */
export function displayMentionText(text: string): string {
  return splitMentions(text).map((s) => s.v).join('');
}

/** 还原到输入框:只留 @文件名,并把 名称->{路径,来源} 一并回传(再次发送时重新序列化) */
export function restoreMentionInput(text: string): { text: string; refs: { name: string; source: MentionSource; path: string }[] } {
  const segs = splitMentions(text);
  const refs: { name: string; source: MentionSource; path: string }[] = [];
  for (const s of segs) if (s.t === 'mention') refs.push({ name: s.name, source: s.source, path: s.path });
  return { text: segs.map((s) => s.v).join(''), refs };
}

export interface AtToken {
  /** @ 字符在正文中的下标 */
  start: number;
  /** 词尾下标(光标所在词的完整范围终点,便于整词替换) */
  end: number;
  /** @ 之后的过滤词(不含 @) */
  query: string;
}

/**
 * 光标处正在编辑的 @词:取光标前的正文,匹配行首/空白后、且紧贴光标的 @词。
 * 命中后把区间向后扩到整个词(光标停在词中间时也能整词替换)。
 * 找不到(光标不在 @词 上)返回 null。
 */
export function atTokenAt(text: string, caret: number): AtToken | null {
  const src = String(text ?? '');
  const c = Math.max(0, Math.min(Number.isFinite(caret) ? caret : src.length, src.length));
  const m = AT_TOKEN_RE.exec(src.slice(0, c));
  if (!m) return null;
  const query = m[1] || '';
  const start = c - query.length - 1;
  let end = c;
  while (end < src.length && /[a-zA-Z0-9_.\-/\\]/.test(src[end])) end += 1;
  return { start, end, query };
}
