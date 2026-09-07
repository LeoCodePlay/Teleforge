// 注册自定义命令到 AppManifest:远程 origin(生产模式 http://127.0.0.1:{port})
// 下自定义命令受 ACL 门控(Tauri >= 2.11.2),必须在清单注册 + capability 授权才能被调用
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "download",
                "update_info",
                "download_update",
                "install_update",
                "open_external",
            ]),
        ),
    )
    .unwrap();
}
