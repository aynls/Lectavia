mod cli;
mod error;
mod locale;
#[cfg(all(feature = "mcp", feature = "desktop"))]
mod mcp;
#[cfg(feature = "mcp")]
#[path = "mcp/stdio.rs"]
mod mcp_stdio;
mod media;
mod models;
mod output;
#[cfg(feature = "desktop")]
mod prompt;
mod settings;
#[cfg(feature = "desktop")]
mod task_runs;
mod video;

pub use cli::run as run_cli;
#[cfg(feature = "mcp")]
pub use mcp_stdio::run as run_mcp;

#[cfg(feature = "desktop")]
pub fn run() {
    use tauri::Manager;

    let builder = tauri::Builder::default()
        .manage(media::AudioCache::default())
        .manage(task_runs::TaskRuns::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "mcp")]
    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(mcp::desktop::McpState::default())
        .setup(mcp::desktop::setup);

    builder
        .invoke_handler(tauri::generate_handler![
            task_runs::begin_task_run,
            task_runs::end_task_run,
            media::probe_remote_video,
            media::fetch_bilibili_video,
            media::resolve_bilibili_short_link,
            media::prepare_media_audio,
            media::remove_media_audio,
            models::list_models,
            models::transcribe_audio,
            models::organize_transcript,
            output::create_output_directory,
            output::validate_output_directory,
            output::write_task_output,
            output::open_output,
            output::reveal_output,
            prompt::choose_prompt_file,
            settings::load_model_settings,
            settings::save_model_settings,
            #[cfg(feature = "mcp")]
            mcp::desktop::get_mcp_status,
            #[cfg(feature = "mcp")]
            mcp::desktop::update_mcp,
            #[cfg(feature = "mcp")]
            mcp::desktop::copy_mcp_config,
        ])
        .build(tauri::generate_context!())
        .expect("failed to launch Lectavia")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                #[cfg(feature = "mcp")]
                mcp::desktop::shutdown(app);
                app.state::<media::AudioCache>().clear();
            }
        });
}
