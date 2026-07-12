//! The entire custom Rust surface of the desktop shell. Everything
//! interesting happens in the bundled launcher page (../src), which
//! resolves the target server and top-level-navigates this window to the
//! server origin; after that the webview is just a browser on the SPA and
//! has no IPC (capabilities grant nothing to remote origins).

use tauri::webview::NewWindowResponse;
use tauri_plugin_opener::OpenerExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // GUI apps inherit launchd's / the desktop environment's minimal
            // PATH; without the fix the shell scope can't find `yaac` from a
            // Homebrew or nvm install.
            if let Err(err) = fix_path_env::fix() {
                eprintln!("fix-path-env failed (spawning `yaac` may not work): {err}");
            }

            let handle = app.handle().clone();
            // Built in Rust (not tauri.conf.json "windows") so on_new_window
            // can be attached. WebviewUrl::App resolves to devUrl under
            // `tauri dev` and to frontendDist in builds.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("yaac")
            .inner_size(1280.0, 800.0)
            .on_new_window(move |url, _features| {
                // The SPA's external links (forwarded ports, upstream docs)
                // are target="_blank": route them to the system browser,
                // never a second webview.
                if matches!(url.scheme(), "http" | "https") {
                    if let Err(err) = handle.opener().open_url(url.as_str(), None::<&str>) {
                        eprintln!("failed to open {url} in the system browser: {err}");
                    }
                }
                NewWindowResponse::Deny
            })
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running yaac desktop");
}
