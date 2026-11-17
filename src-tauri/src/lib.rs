mod media;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            media::probe_remote_video,
            media::fetch_bilibili_video,
            media::resolve_bilibili_short_link,
            media::prepare_media_audio,
            media::remove_media_audio,
        ])
        .run(tauri::generate_context!())
        .expect("failed to launch Lectavia");
}
