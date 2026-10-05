// Node 后端 sidecar 生命周期:找空闲端口 → spawn node → 轮询 /api/health → 导航主窗口
//                                → 守护(意外退出就自动重启)→ 退出清理
// 启动/健康检查/守护仅在 release(生产)模式被调用,dev 模式由 vite 代理 + 外部 server 承担,
// 故这些项整体带 #[cfg(not(debug_assertions))],避免调试构建产生 dead_code 告警。
#[cfg(not(debug_assertions))]
use std::io::{Read, Write};
#[cfg(not(debug_assertions))]
use std::net::{TcpListener, TcpStream};
#[cfg(not(debug_assertions))]
use std::process::Command;
use std::process::Child;
#[cfg(not(debug_assertions))]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct BackendState {
    pub port: u16,
    pub child: Mutex<Option<Child>>,
    /// 应用正在退出(见 stop):守护循环据此停止自动重启,避免"退出时又被拉起来"
    pub stopping: AtomicBool,
    /// 「本次退出是用户主动的」标记文件(由后端在下次启动时读取并删除):
    /// 有了它,后端才能区分"进程崩了该自动接着做"与"用户自己关了软件,别擅自继续"
    pub quit_flag: std::path::PathBuf,
}

#[cfg(not(debug_assertions))]
const HEALTH_TIMEOUT_SECS: u64 = 30;

/// 自动重启次数上限:后端若反复启动即崩(端口被占、运行时损坏等),继续重启只会刷屏,
/// 达到上限就放弃并写明原因,让界面上的提示"请重启本应用"仍然成立。
#[cfg(not(debug_assertions))]
const MAX_RESTARTS: u32 = 8;

/// 桌面端后端监听的端口区间。浏览器扩展(Teleforge Auto)靠扫描这段区间发现服务端,
/// 所以必须是有限且可枚举的 —— 用随机端口时用户装好扩展也不知道该填什么。
/// 改这里要同步改 extension/background.js 的 PORT_RANGE_*。
#[cfg(not(debug_assertions))]
const PORT_RANGE_START: u16 = 4000;
#[cfg(not(debug_assertions))]
const PORT_RANGE_END: u16 = 4019;

/// 拉起后端所需的一切:重启时按同一份参数再来一次(端口/数据目录/资源路径都保持不变,
/// 前端 WebSocket 自动重连即可接上,不需要重新导航窗口)。
#[cfg(not(debug_assertions))]
struct SpawnSpec {
    node: String,
    entry: String,
    res: String,
    port: u16,
    data_dir: std::path::PathBuf,
    log_path: std::path::PathBuf,
}

#[cfg(not(debug_assertions))]
fn open_log(p: &std::path::Path) -> Stdio {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

/// 后端日志上限:超过就滚成 backend.log.1(旧的直接覆盖)。
/// 日志是 append 打开的、进程一跑就是几天,不设上限会无限增长(实测出过 525MB 的单文件,
/// 里面绝大部分是逐请求日志)。每次拉起后端子进程前检查一次,滚动点天然落在重启时。
#[cfg(not(debug_assertions))]
const LOG_MAX_BYTES: u64 = 32 * 1024 * 1024;

#[cfg(not(debug_assertions))]
fn rotate_log(p: &std::path::Path) {
    if let Ok(m) = std::fs::metadata(p) {
        if m.len() > LOG_MAX_BYTES {
            let bak = p.with_extension("log.1");
            let _ = std::fs::remove_file(&bak);
            let _ = std::fs::rename(p, &bak);
        }
    }
}

/// 往后端日志里追加一行带 [teleforge] 前缀的说明:release 版应用的 stderr 没有去处,
/// 重启/退出这类外壳行为只有落到 backend.log 才能在事后排查。
#[cfg(not(debug_assertions))]
fn note(log_path: &std::path::Path, msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(f, "[teleforge] {msg}");
    }
}

#[cfg(not(debug_assertions))]
impl SpawnSpec {
    fn spawn(&self) -> std::io::Result<Child> {
        rotate_log(&self.log_path);
        let mut cmd = Command::new(&self.node);
        cmd.arg(&self.entry)
            .env("PORT", self.port.to_string())
            .env("HOST", "127.0.0.1")
            .env("DATA_DIR", &self.data_dir)
            // 让服务端知道自己跑在桌面端外壳里(配对接口据此回传 kind:'desktop',
            // 浏览器扩展靠它在服务端列表里标出「桌面端 / 网页端」)
            .env("TELEFORGE_SHELL", "desktop")
            .current_dir(&self.res)
            .stdout(open_log(&self.log_path))
            .stderr(open_log(&self.log_path));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW:不闪现控制台
        }
        cmd.spawn()
    }
}

/// 生产模式入口:在后台线程运行,完成后把主窗口导航到后端地址,随后转入守护循环
#[cfg(not(debug_assertions))]
pub fn spawn_and_wait(handle: AppHandle) {
    // 1. 找空闲端口。优先在固定区间里挑(扩展要能扫到);区间全被占用才退回系统随机端口,
    //    那种情况下只能靠用户在 popup 里手填地址。(先绑再释放,单实例场景竞态可接受。)
    let port = (PORT_RANGE_START..=PORT_RANGE_END)
        .find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .or_else(|| {
            TcpListener::bind("127.0.0.1:0")
                .ok()
                .and_then(|l| l.local_addr().ok())
                .map(|a| a.port())
        })
        .unwrap_or(4000);

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
    // 与后端 config.ts 的 QUIT_FLAG_FILE 同名(默认 DATA_DIR/clean-quit.flag),改一处要改两处
    let quit_flag = data_dir.join("clean-quit.flag");

    // 4. spawn node server/index.ts(current_dir=资源根,保证相对路径解析一致)
    let spec = SpawnSpec { node: node_str, entry: entry_str, res: res_str, port, data_dir, log_path };
    let child = match spec.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[teleforge] 启动 Node 后端失败: {e}");
            return;
        }
    };
    handle.manage(BackendState {
        port,
        child: Mutex::new(Some(child)),
        stopping: AtomicBool::new(false),
        quit_flag,
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

    // 6. 守护:进程意外退出就按退避自动拉起
    supervise(handle, spec);
}

/// 守护循环:后端进程意外退出时自动重启。
/// 背景:后端一旦退出,界面顶部会出现「与本地服务的连接已断开…若长时间不恢复,请重启本应用」,
/// 而正在跑的那一轮连 turn/end 都来不及写,重启应用后才只剩「上一轮对话没有正常结束」。
/// 同端口重启对界面是透明的 —— 前端 WebSocket 本来就会自动重连,所以这里不重新导航窗口。
#[cfg(not(debug_assertions))]
fn supervise(handle: AppHandle, spec: SpawnSpec) {
    let mut restarts: u32 = 0;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let state = handle.state::<BackendState>();
        if state.stopping.load(Ordering::SeqCst) {
            return;
        }
        // try_wait 而非 wait:wait 会一直占着锁,stop() 就拿不到子进程去 kill
        let dead = match state.child.lock() {
            Ok(mut g) => match g.as_mut() {
                Some(c) => !matches!(c.try_wait(), Ok(None)),
                None => true,
            },
            Err(_) => return,
        };
        if !dead {
            continue;
        }
        if restarts >= MAX_RESTARTS {
            note(&spec.log_path, &format!("后端反复退出(已自动重启 {restarts} 次),不再重启,请重启应用"));
            return;
        }
        restarts += 1;
        let secs = 1u64 << (restarts - 1).min(3); // 1/2/4/8s
        note(&spec.log_path, &format!("后端进程意外退出,{secs}s 后自动重启(第 {restarts} 次)"));
        std::thread::sleep(std::time::Duration::from_secs(secs));
        if handle.state::<BackendState>().stopping.load(Ordering::SeqCst) {
            return;
        }
        match spec.spawn() {
            Ok(c) => {
                if let Ok(mut g) = state.child.lock() {
                    *g = Some(c);
                }
                let mut ok = false;
                for _ in 0..(HEALTH_TIMEOUT_SECS * 10) {
                    if state.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    if health_ok(spec.port) {
                        ok = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                note(&spec.log_path, if ok {
                    "后端已自动重启并就绪(界面自行重连,无需重启应用)"
                } else {
                    "后端重启后未在超时内就绪"
                });
            }
            Err(e) => note(&spec.log_path, &format!("后端自动重启失败: {e}")),
        }
    }
}

/// 原始 TCP GET 健康检查(仅访问本机明文 http,无需 HTTP 客户端)
#[cfg(not(debug_assertions))]
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

/// 退出时回收后端子进程(并让守护循环别再把它拉起来)
pub fn stop(handle: &AppHandle) {
    if let Some(state) = handle.try_state::<BackendState>() {
        state.stopping.store(true, Ordering::SeqCst);
        // 先落"主动退出"标记再 kill:Windows 上 kill = TerminateProcess,后端子进程收不到信号、
        // 来不及自己写标记,这件事只能由外壳代劳(后端下次启动读到就不做自动续跑)。
        let _ = std::fs::write(&state.quit_flag, format!("{{\"at\":{},\"reason\":\"app-quit\"}}", now_ms()));
        if let Some(mut child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 当前毫秒时间戳(标记文件里只用来说明"什么时候退出的")
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// 只在 release 语义下有意义(日志轮转本身带 not(debug_assertions),dev 构建没有这个函数):
// 用 `cargo test --release` 跑。
#[cfg(all(test, not(debug_assertions)))]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tf-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotate_log_rolls_over_limit_and_keeps_small_files() {
        let dir = tmp_dir("log-rotate");
        let log = dir.join("backend.log");
        let bak = dir.join("backend.log.1");

        // 未超限:原样不动
        std::fs::write(&log, b"small").unwrap();
        rotate_log(&log);
        assert_eq!(std::fs::read(&log).unwrap(), b"small");
        assert!(!bak.exists());

        // 超限:滚成 .1(用 set_len 造稀疏大文件,不真占磁盘)
        let f = std::fs::OpenOptions::new().write(true).open(&log).unwrap();
        f.set_len(LOG_MAX_BYTES + 1).unwrap();
        drop(f);
        rotate_log(&log);
        assert!(!log.exists(), "超限日志应被滚走");
        assert!(bak.exists(), "应生成 backend.log.1");
        assert!(std::fs::metadata(&bak).unwrap().len() > LOG_MAX_BYTES);

        // 再次超限:旧的 .1 被新的一份覆盖(不会无限堆积)
        std::fs::write(&log, b"x").unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&log).unwrap();
        f.set_len(LOG_MAX_BYTES + 2).unwrap();
        drop(f);
        rotate_log(&log);
        assert!(bak.exists() && !log.exists());
        assert_eq!(std::fs::metadata(&bak).unwrap().len(), LOG_MAX_BYTES + 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
