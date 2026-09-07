// Node 后端 sidecar 生命周期:找空闲端口 → spawn node → 轮询 /api/health → 导航主窗口 → 退出清理
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct BackendState {
    pub port: u16,
    pub child: Mutex<Option<Child>>,
}

const HEALTH_TIMEOUT_SECS: u64 = 30;

/// 生产模式入口:在后台线程运行,完成后把主窗口导航到后端地址
pub fn spawn_and_wait(handle: AppHandle) {
    // 1. 找空闲端口(先绑 127.0.0.1:0 拿端口再释放;单实例场景竞态可接受)
    let port = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l.local_addr().map(|a| a.port()).unwrap_or(4000),
        Err(_) => 4000,
    };

    // 2. 定位打包资源($RESOURCE 布局见 scripts/build.mjs)
    let res = match handle.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[teleforge] 无法定位资源目录: {e}");
            return;
        }
    };
    let node = if cfg!(windows) {
        res.join("node").join("node.exe")
    } else {
        res.join("node").join("bin").join("node")
    };
    let entry = res.join("server").join("index.ts");
    if !node.exists() || !entry.exists() {
        eprintln!("[teleforge] 缺少后端运行时资源(resources 未打包?): {}", res.display());
        return;
    }
    // 统一转运行时路径(剥 \\?\ 前缀 + 正斜杠),避免 Node 22 对 \\?\ 前缀入口崩溃
    fn to_runtime_str(p: &std::path::Path) -> String {
        let s = p.to_string_lossy();
        let s = s
            .strip_prefix(r"\\?\UNC\")
            .map(|r| format!("\\\\{}", r))
            .or_else(|| s.strip_prefix(r"\\?\").map(|r| r.to_string()))
            .unwrap_or_else(|| s.to_string());
        s.replace('\\', "/")
    }
    let node_str = to_runtime_str(&node);
    let entry_str = to_runtime_str(&entry);
    let res_str = to_runtime_str(&res);

    // 3. 数据目录 = App 数据目录,后端日志落同目录
    let data_dir = match handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[teleforge] 无法定位数据目录: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("[teleforge] 创建数据目录失败: {e}");
        return;
    }
    let log_path = data_dir.join("backend.log");
    let log_stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let log_stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());

    // 4. spawn node server/index.ts(current_dir=资源根,保证相对路径解析一致)
    let mut cmd = Command::new(&node_str);
    cmd.arg(&entry_str)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("DATA_DIR", &data_dir)
        .current_dir(&res_str)
        .stdout(log_stdout)
        .stderr(log_stderr);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW:不闪现控制台
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[teleforge] 启动 Node 后端失败: {e}");
            return;
        }
    };
    handle.manage(BackendState {
        port,
        child: Mutex::new(Some(child)),
    });

    // 5. 轮询 /api/health,就绪后导航主窗口
    let url = format!("http://127.0.0.1:{port}");
    let mut ready = false;
    for _ in 0..(HEALTH_TIMEOUT_SECS * 10) {
        if health_ok(port) {
            ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !ready {
        eprintln!("[teleforge] 后端 {HEALTH_TIMEOUT_SECS}s 内未就绪,仍尝试打开窗口");
    }
    let target = format!("{url}/");
    let handle2 = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = handle2.get_webview_window("main") {
            if let Ok(u) = tauri::Url::parse(&target) {
                let _ = w.navigate(u);
            }
        }
    });
}

/// 原始 TCP GET 健康检查(仅访问本机明文 http,无需 HTTP 客户端)
fn health_ok(port: u16) -> bool {
    let addr: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)) else {
        return false;
    };
    if s.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    if s.read(&mut buf).is_err() {
        return false;
    }
    String::from_utf8_lossy(&buf[..buf.len().min(128)]).contains("200")
}

/// 退出时回收后端子进程
pub fn stop(handle: &AppHandle) {
    if let Some(state) = handle.try_state::<BackendState>() {
        if let Some(mut child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
