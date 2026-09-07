// 下载命令:webview 无法直接触发浏览器下载,由 Rust 从本机后端拉字节流 + 原生保存对话框落盘
use std::io::Write;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Deserialize)]
pub struct DownloadArgs {
    /// 后端相对路径+query,如 /api/download?path=... 或 /api/media?download=1&...
    pub api_path: String,
    /// 保存对话框默认文件名(用户可修改)
    pub suggested_name: String,
}

#[tauri::command]
pub async fn download(app: tauri::AppHandle, args: DownloadArgs) -> Result<String, String> {
    // 1. 原生保存对话框(回调式:插件内部在主线程调度,规避 Linux GTK 上阻塞 API 的死锁)
    let (tx, rx) = std::sync::mpsc::channel::<Option<std::path::PathBuf>>();
    app.dialog()
        .file()
        .set_file_name(&args.suggested_name)
        .save_file(move |p| {
            let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
        });
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(3600))
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.map_err(|e| e.to_string())? else {
        return Ok(String::new()); // 用户取消
    };

    // 2. 从本机后端拉取(仅 http 明文,不启用 TLS)
    let port = app
        .try_state::<crate::backend::BackendState>()
        .map(|s| s.port)
        .ok_or_else(|| "后端未运行(下载命令仅桌面生产模式可用)".to_string())?;
    let url = format!("http://127.0.0.1:{port}{}", args.api_path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("后端返回 {}", resp.status()));
    }

    // 3. 流式落盘
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}
