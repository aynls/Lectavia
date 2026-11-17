mod error;
mod media;
mod models;
mod output;
mod prompt;
mod settings;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            media::probe_remote_video,
            media::fetch_bilibili_video,
            media::resolve_bilibili_short_link,
            media::prepare_media_audio,
            media::remove_media_audio,
            models::list_models,
            models::transcribe_audio_chunk,
            models::complete_text,
            output::create_output_directory,
            output::default_output_directory,
            output::validate_output_directory,
            output::write_output,
            output::open_output,
            output::reveal_output,
            prompt::choose_prompt_file,
            settings::load_model_settings,
            settings::save_model_settings,
        ])
        .run(tauri::generate_context!())
        .expect("failed to launch Lectavia");
}
