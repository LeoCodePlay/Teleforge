// GitHub 自动更新链路前端封装(仅桌面生产壳可用;浏览器/开发模式优雅降级)
// - getUpdateInfo():检查 GitHub 最新发布,返回当前版本/最新版本/安装包直链/配置目录等
// - downloadUpdate():下载安装包到 App 数据目录/updates/,期间监听 update-progress 事件回报进度
// - installUpdate():拉起安装程序并关闭当前应用(Windows)
// - openExternal():系统默认浏览器打开外部链接
import { isDesktop } from './desktop';

/** GitHub 仓库 Releases 页(浏览器模式也展示「前往下载」链接) */
export const UPDATE_REPO_URL = 'https://github.com/LeoCodePlay/Teleforge/releases';

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  notes: string;
  assetUrl: string;
  fileName: string;
  assetSize: number;
  publishedAt: string;
  /** 配置与数据目录(App data dir);安装包内不含任何用户配置 */
  dataDir: string;
  repoUrl: string;
}

export interface DownloadProgress {
  received: number;
  total: number;
  percent: number;
}

function tauri(): any {
  return (window as any).__TAURI__;
}

/** 检查更新:非桌面壳返回 null(前端按「无更新」处理) */
export async function getUpdateInfo(): Promise<UpdateInfo | null> {
  if (!isDesktop()) return null;
  try {
    return await tauri().core.invoke('update_info');
  } catch (e) {
    console.error('检查更新失败:', e);
    throw e;
  }
}

/** 下载安装包;onProgress 收到 (0,1] 的进度;返回落盘路径 */
export async function downloadUpdate(
  assetUrl: string,
  fileName: string,
  onProgress: (p: DownloadProgress) => void
): Promise<string> {
  const t = tauri();
  const unlisten = await t.event.listen('update-progress', (e: { payload: DownloadProgress }) => {
    onProgress(e.payload);
  });
  try {
    return (await t.core.invoke('download_update', { url: assetUrl, fileName })) as string;
  } finally {
    unlisten();
  }
}

/** 安装更新(Windows):Rust 拉起安装程序后自动退出本应用 */
export async function installUpdate(path: string): Promise<void> {
  await tauri().core.invoke('install_update', { path });
}

// ---- 已下载安装包的持久化记录 ----
// 下载完成状态只存在组件内存里,关闭设置/刷新面板后会丢——"立即安装"按钮就消失了,
// 再次点下载又因文件已存在而"秒完成"却没有后续。这里把已下载的版本+路径落盘,
// 面板重新打开时恢复,保证「立即重启安装」按钮始终出现。
const DOWNLOAD_KEY = 'sshai.updater.downloaded';

export interface StoredDownload {
  /** 已下载的版本号(与 UpdateInfo.latest 比较,不一致则失效) */
  latest: string;
  /** 安装包落盘路径 */
  path: string;
  ts: number;
}

export function saveDownloadedUpdate(d: StoredDownload): void {
  try { localStorage.setItem(DOWNLOAD_KEY, JSON.stringify(d)); } catch { /* 容量/隐私模式忽略 */ }
}

export function loadDownloadedUpdate(): StoredDownload | null {
  try {
    const j = JSON.parse(localStorage.getItem(DOWNLOAD_KEY) || 'null');
    if (j && typeof j.latest === 'string' && typeof j.path === 'string') return j as StoredDownload;
  } catch { /* 损坏则视为无 */ }
  return null;
}

export function clearDownloadedUpdate(): void {
  try { localStorage.removeItem(DOWNLOAD_KEY); } catch { /* 忽略 */ }
}

/** 系统浏览器打开外部链接;浏览器模式回落 window.open */
export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank');
    return;
  }
  try {
    await tauri().core.invoke('open_external', { url });
  } catch (e) {
    console.error('打开链接失败:', e);
  }
}

/** 配置目录展示兜底:Windows 下 App data dir 的常见形态,便于非桌面模式提示用户 */
export const DEFAULT_DATA_DIR_HINT = 'Windows: %APPDATA%\\com.teleforge.desktop';
