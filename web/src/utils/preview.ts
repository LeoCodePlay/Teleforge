// 浏览器预览地址识别与打开:统一「什么地址值得用内置浏览器预览打开」的判定,
// 供聊天里的链接点击拦截、命令输出提示、预览标签工具栏共用。
//
// 判定原则(宁可放过正常外链,也不要把普通文本误判成地址):
//   - 回环地址(localhost / 127.x / 0.0.0.0 / ::1)与 .local/.localhost 等内网域名;
//   - 私有网段 IP(10.x / 192.168.x / 172.16-31.x)与任意裸 IP;
//   - 带显式端口(非 80/443)的地址 —— 开发服务器几乎都带端口。
// 其余(公网域名、无端口的普通网址)按普通外链处理,不劫持。

/** 触发「打开浏览器预览标签」的全局事件名(工具卡按钮等非 App 内部位置用它解耦) */
export const PREVIEW_EVENT = 'teleforge:open-preview';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|::1)$/i;
const PRIVATE_V4 = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/;
const INTERNAL_HOST = /\.(local|localhost|internal|test)$/i;
const BARE_IP = /^(\d{1,3}\.){3}\d{1,3}$/;

/** 主机名 + 端口是否值得用内置预览打开 */
export function isPreviewHost(hostname: string, port = ''): boolean {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (LOOPBACK.test(host) || PRIVATE_V4.test(host) || BARE_IP.test(host) || INTERNAL_HOST.test(host)) return true;
  // 带非标准端口的地址:多半是本地/局域网里跑的服务
  const p = String(port || '');
  return !!p && p !== '80' && p !== '443';
}

/** 该 URL 是否应当用内置浏览器预览打开(而非跳系统浏览器) */
export function isPreviewUrl(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return isPreviewHost(u.hostname, u.port);
  } catch {
    return false;
  }
}

/**
 * 是否是可以交给内置预览面板接管的普通链接(任意 http/https)。
 * 与 isPreviewUrl 的分工:
 *   - isPreviewUrl:判断值不值得当作「项目预览」主动提示(本地/内网/带端口);
 *   - isHttpLink:判断聊天里的链接要不要拦截 —— 全部接管,因为桌面壳(安装包)里
 *     放行 webview 自己导航会把整个应用页面替换成目标网页,而且没有后退键可回。
 */
export function isHttpLink(raw: string): boolean {
  return /^https?:\/\//i.test(String(raw || '').trim());
}

/** 地址栏输入归一化:补协议、去掉首尾噪声字符;无法识别返回 null */
export function normalizePreviewInput(raw: string): string | null {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^[<("'`[]+/, '').replace(/[>)"'`\]，。；、.,;:!?]+$/, '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?([/?#].*)?$/i.test(s)) return 'http://' + s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}([/?#].*)?$/i.test(s)) return 'http://' + s;
  if (/^\d{2,5}$/.test(s)) return 'http://localhost:' + s;
  return null;
}

/** 从一段文本里提取所有值得预览的地址(去重,保持出现顺序) */
export function extractPreviewUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'`<>()\[\]，。；、]+/gi;
  const src = String(text || '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // 去掉句末常见的标点/闭合符号
    const url = m[0].replace(/[.,;:!?)\]}>，。；、]+$/, '');
    if (!isPreviewUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 5) break;
  }
  return out;
}

/** 标签名:优先「host:port」,便于一眼看出是哪个服务 */
export function previewLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0' ? 'localhost' : u.hostname;
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return '浏览器预览';
  }
}

/** 请求 App 打开(或导航)浏览器预览标签(与 App 解耦的全局事件入口) */
export function openPreview(url: string): void {
  const u = normalizePreviewInput(url);
  if (!u) return;
  try {
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: { url: u } }));
  } catch { /* 忽略 */ }
}

/**
 * 触摸拖动 → wheel 增量。
 * 方向必须与浏览器原生手势一致:手指上滑 = 页面向下滚 = deltaY 为正。
 * 单独成纯函数是为了可测试——符号写反会让预览页"倒着滚",是很难在代码里看出来的 bug。
 */
export function touchDragDelta(
  last: { x: number; y: number },
  cur: { x: number; y: number }
): { dx: number; dy: number } {
  return { dx: last.x - cur.x, dy: last.y - cur.y };
}

// ---------------- 预览标签 ↔ 会话的绑定(一个预览浏览器只服务一个对话) ----------------
// 标签 id = `${BROWSER_TAB_PREFIX}${会话id}:${序号}`;服务端浏览器会话 id 里直接编着归属会话
// (见 server/core/browser-manager.ts 文件头),所以"谁开的就是谁的"在前后端都是同一个约定:
// 前端拿 id 决定标签归属,服务端拿 id 校验权限,两边不需要额外同步。

/** 预览标签 id 前缀('preview:' + 服务端浏览器会话 id),避免与固定页/文件路径撞名 */
export const BROWSER_TAB_PREFIX = 'preview:';

/** 「新会话草稿」的占位会话 id:草稿期开的预览也先绑到它,首条消息落地后由服务端改名为真实会话 */
export const DRAFT_SESSION_PREFIX = 'd_';

/** 无归属的兜底值:浏览器模式下手动开预览、或升级前遗留的共享预览(任何会话都不独占) */
export const LEGACY_BROWSER_SESSION = 'main';

/** 预览标签 id ← 服务端浏览器会话 id */
export const browserTabId = (browserId: string): string => BROWSER_TAB_PREFIX + String(browserId || '');

/** 服务端浏览器会话 id ← 预览标签 id(非预览标签原样返回) */
export const browserSessionId = (tabId: string): string =>
  String(tabId || '').startsWith(BROWSER_TAB_PREFIX) ? String(tabId).slice(BROWSER_TAB_PREFIX.length) : String(tabId || '');

const SESSION_ID_RE = /^s_[0-9a-z]+$/i;
const DRAFT_ID_RE = /^d_[0-9a-z]+$/i;

/** 生成的会话标识是否合法(真实会话 s_… 或新会话草稿 d_…),与服务端 isBrowserOwner 同规则 */
export function isSessionScoped(sid: unknown): boolean {
  const s = String(sid ?? '').trim();
  return SESSION_ID_RE.test(s) || DRAFT_ID_RE.test(s);
}

/**
 * 该 sid 是否指向"服务端已存在的会话"(真实会话 s_…)。
 * 草稿 d_…、新建态 __new__、空值都还没有服务端会话,不能作为会话级配置(如模型)的下发目标。
 */
export function isRealSessionId(sid: unknown): boolean {
  return SESSION_ID_RE.test(String(sid ?? '').trim());
}

/** 预览会话 id 所属的会话(null = 无归属:旧版共享的 main 等) */
export function ownerOfBrowserId(browserId: unknown): string | null {
  const s = String(browserId ?? '').trim();
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return isSessionScoped(s.slice(0, i)) ? s.slice(0, i) : null;
}

/** 某个会话当前有几个预览标签 */
export function countPreviewTabs(ids: Iterable<string>, sid: string): number {
  let n = 0;
  for (const id of ids) if (ownerOfBrowserId(id) === sid) n += 1;
  return n;
}

/** 某个会话的下一个空闲预览 id(:1 已有就 :2、:3 …),用于"再开一个预览" */
export function allocBrowserId(ids: Iterable<string>, sid: string): string {
  const used = new Set<string>(ids as Iterable<string>);
  const prefix = `${String(sid).trim()}:`;
  for (let n = 1; n < 100; n++) {
    const id = prefix + n;
    if (!used.has(id)) return id;
  }
  return prefix + Date.now().toString(36);
}

/** 新会话草稿标识(每次进入草稿态生成一个,草稿期开的预览都绑在它名下) */
export function newDraftSessionId(): string {
  return DRAFT_SESSION_PREFIX + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/** 预览所属会话的显示名:优先会话标题,会话已被删除时给出明确说明 */
export function ownerSessionLabel(ownerSid: string | null | undefined, title?: string | null): string {
  const sid = String(ownerSid ?? '').trim();
  if (!sid) return '共享预览(未绑定会话)';
  if (sid.startsWith(DRAFT_SESSION_PREFIX)) return title || '新会话(尚未发送)';
  return title || sid;
}
