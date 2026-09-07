mod backend;
mod commands;

/// Tauri 应用装配:
/// - 生产模式(not debug):后台线程启动 Node 后端 sidecar,健康检查就绪后导航主窗口
/// - 开发模式:后端/前端由 `npm run dev`(vite + server)提供,壳只做 webview
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = &app;
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                // 不能在 setup 里阻塞(会延迟窗口创建),spawn 到后台线程
                std::thread::spawn(move || backend::spawn_and_wait(handle));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::download,
            commands::update_info,
            commands::download_update,
            commands::install_update,
            commands::open_external
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // 退出时确保子进程(node 后端)一并回收,不留孤儿进程
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => backend::stop(app_handle),
            _ => {}
        });
}
