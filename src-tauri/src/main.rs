// 桌面端入口:生产模式隐藏控制台窗口,交由 teleforge_lib::run 启动
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    teleforge_lib::run();
}
