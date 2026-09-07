/// <reference types="vite/client" />
// 桌面端(Tauri)能力探测与下载桥:浏览器模式自动回落原生行为
// - isDesktop():生产桌面壳由 Tauri 注入 window.__TAURI__(tauri.conf.json 的 withGlobalTauri);
//   开发模式(vite dev,壳不 spawn 后端)不拦截,下载仍走浏览器原生
// - downloadViaTauri():桌面端经 Rust 命令走原生保存对话框;浏览器端回落 window.open

export function isDesktop(): boolean {
  if (typeof window === 'undefined' || !('__TAURI__' in window) || !(window as any).__TAURI__) {
    return false;
  }
  return !import.meta.env.DEV;
}

/** 下载后端资源(相对路径+query)。suggestedName 仅作保存对话框默认文件名,可由用户修改 */
export function downloadViaTauri(apiPath: string, suggestedName: string): void {
  if (!isDesktop()) {
    window.open(apiPath, '_blank');
    return;
  }
  const tauri = (window as any).__TAURI__;
  tauri.core.invoke('download', { apiPath, suggestedName }).catch((e: Error) => {
    console.error('下载失败:', e);
    alert('下载失败: ' + (e?.message || String(e)));
  });
}
