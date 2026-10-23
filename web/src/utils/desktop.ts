/// <reference types="vite/client" />
// 桌面端(Tauri)能力探测与下载桥:浏览器模式自动回落原生行为
// - isTauri():是否运行在 Tauri 窗口(dev/prod 都成立;窗口 API/拖拽区/标题栏按钮以此为准)
// - isDesktop():生产桌面壳判定(dev 模式不拦截,下载仍走浏览器原生)
// - downloadViaTauri():桌面端经 Rust 命令走原生保存对话框;浏览器端回落 window.open

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window && !!(window as any).__TAURI__;
}

export function isDesktop(): boolean {
  return isTauri() && !import.meta.env.DEV;
}

/** 下载后端资源(相对路径+query)。suggestedName 仅作保存对话框默认文件名,可由用户修改 */
export function downloadViaTauri(apiPath: string, suggestedName: string): void {
  if (!isDesktop()) {
    window.open(apiPath, '_blank');
    return;
  }
  const tauri = (window as any).__TAURI__;
  // Rust 侧命令签名是 download(args: DownloadArgs):具名结构体参数必须整包放进 `args`,
  // 平铺成 { apiPath, suggestedName } 会被 Tauri 判为 missing required key `args`;
  // 结构体内部的字段名走 serde(api_path / suggested_name),不跟外层参数的 camelCase 规则。
  tauri.core.invoke('download', { args: { api_path: apiPath, suggested_name: suggestedName } }).catch((e: Error) => {
    console.error('下载失败:', e);
    alert('下载失败: ' + (e?.message || String(e)));
  });
}
