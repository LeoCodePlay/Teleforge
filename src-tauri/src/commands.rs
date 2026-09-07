// 自定义命令(全部经 build.rs 注册进 AppManifest + capability 授权,远程 origin 才能调用)
// 1. download:webview 无法直接触发浏览器下载,由 Rust 从本机后端拉字节流 + 原生保存对话框落盘
// 2. update_info / download_update / install_update:GitHub 自动更新链路(检查 → 下载 → 关闭应用并安装)
// 3. open_external:用系统默认浏览器打开外部链接(webview 内 window.open 在桌面壳不可用)
use std::io::Write;
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

// ---- 通用 ----

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

// ---- GitHub 自动更新 ----

/// 更新信息(返回给前端渲染「关于与更新」面板)。
/// 同时携带 data_dir:桌面端用户配置文件统一落在该目录(安装包内不含任何用户配置)。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 当前应用版本(package 版本,来自 Cargo.toml)
    pub current: String,
    /// GitHub 最新 release 版本(去掉前缀 v)
    pub latest: String,
    pub has_update: bool,
    /// release 正文(更新说明)
    pub notes: String,
    /// Windows 安装包直链
    pub asset_url: String,
    pub file_name: String,
    pub asset_size: u64,
    pub published_at: String,
    /// 配置与数据目录(App data dir),安装包不含任何用户配置
    pub data_dir: String,
    /// GitHub Releases 页面
    pub repo_url: String,
}

#[derive(serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(serde::Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

/// 更新来源仓库;可在构建时用环境变量 TF_UPDATE_REPO 覆盖(如 fork)
const UPDATE_REPO: &str = match option_env!("TF_UPDATE_REPO") {
    Some(v) => v,
    None => "LeoCodePlay/Teleforge",
};

/// 检查 GitHub 最新版本:拉取 latest release,挑选 Windows 安装包(NSIS setup.exe,优先 x64)
#[tauri::command]
pub async fn update_info(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Teleforge-Desktop")
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("无法连接 GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub 返回 HTTP {}", resp.status()));
    }
    let rel: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析发布信息失败: {e}"))?;

    // 挑选 Windows 安装包资源(NSIS 产物为 *-setup.exe;x64 优先)
    let mut wins: Vec<&GhAsset> = rel.assets.iter().filter(|a| a.name.ends_with(".exe")).collect();
    wins.sort_by_key(|a| if a.name.contains("x64") { 0 } else { 1 });
    let Some(asset) = wins.first() else {
        return Err("GitHub 最新发布中未找到 Windows 安装包".to_string());
    };

    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = rel.tag_name.trim_start_matches('v').to_string();
    let has_update = cmp_version(&parse_version(&latest), &parse_version(&current)).is_gt();

    let data_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(UpdateInfo {
        current,
        latest,
        has_update,
        notes: rel.body.unwrap_or_default(),
        asset_url: asset.browser_download_url.clone(),
        file_name: asset.name.clone(),
        asset_size: asset.size.unwrap_or(0),
        published_at: rel.published_at.unwrap_or_default(),
        data_dir,
        repo_url: format!("https://github.com/{UPDATE_REPO}/releases"),
    })
}

/// 解析版本串(去掉 v 前缀,按数字段拆,忽略 -beta 等后缀):"v0.1.1" → [0,1,1]
fn parse_version(s: &str) -> Vec<u32> {
    s.trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse::<u32>().ok())
        .collect()
}

fn cmp_version(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

/// 下载进度(下载期间持续向前端广播 update-progress 事件)
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
    percent: f64,
}

/// 下载安装包到「App 数据目录/updates/」,返回落盘路径;进度通过 update-progress 事件上报
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = data_dir.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = dir.join(&file_name);
    if final_path.exists() {
        // 已下载过则直接复用(重试/重复点击场景避免重复拉取)
        return Ok(final_path.to_string_lossy().into_owned());
    }
    // 先写 .part 再改名:中途失败不残留可被复用的半成品
    let part_path = dir.join(format!("{file_name}.part"));
    let _ = std::fs::remove_file(&part_path);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| format!("下载失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        let percent = if total > 0 { received as f64 / total as f64 } else { 0.0 };
        let _ = app.emit(
            "update-progress",
            DownloadProgress { received, total, percent },
        );
    }
    // 落盘成功后重命名为正式文件名
    std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().into_owned())
}

/// 安装更新(仅 Windows):拉起安装程序后退出本应用——NSIS 需要覆盖正在运行的
/// teleforge.exe,必须先关闭自己。安装程序独立进程继续执行(UAC + 安装 UI)。
#[tauri::command]
pub fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err("安装包不存在或已被删除".to_string());
        }
        // 不用 CREATE_NO_WINDOW:安装程序需要展示 UAC 提示与安装界面
        std::process::Command::new(&p)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
        // 等安装程序进程完全拉起后退出本应用(否则过快退出可能中断子进程)
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            let h = handle.clone();
            let _ = h.run_on_main_thread(move || handle.exit(0));
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path);
        Err("当前平台暂不支持一键安装,请前往 GitHub Releases 手动下载".to_string())
    }
}

/// 用系统默认浏览器打开外部链接
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url.as_str()])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开链接失败: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开链接失败: {e}"))
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开链接失败: {e}"))
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = url;
        Err("当前平台不支持打开外部链接".to_string())
    }
}
