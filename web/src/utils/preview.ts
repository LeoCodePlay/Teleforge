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
