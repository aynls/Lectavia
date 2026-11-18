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
mod tasks;
mod video;

pub use cli::run as run_cli;
#[cfg(feature = "mcp")]
pub use mcp_stdio::run as run_mcp;

#[cfg(feature = "desktop")]
pub fn run() {
    use tauri::Manager;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "mcp")]
    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(mcp::desktop::McpState::default());

    builder
        .setup(|app| {
            tasks::desktop::setup(app)?;
            #[cfg(feature = "mcp")]
            mcp::desktop::setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tasks::desktop::get_max_concurrency,
            tasks::desktop::set_max_concurrency,
            tasks::desktop::inspect_task_video,
            tasks::desktop::submit_task,
            tasks::desktop::list_tasks,
            tasks::desktop::get_task_draft,
            tasks::desktop::cancel_task,
            tasks::desktop::remove_tasks,
            tasks::desktop::retry_task,
            models::list_models,
            output::validate_output_directory,
            output::open_output,
            output::reveal_output,
            prompt::choose_prompt_file,
            settings::load_audio_chunk_seconds,
            settings::save_audio_chunk_seconds,
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
                tauri::async_runtime::block_on(app.state::<tasks::Tasks>().shutdown());
            }
        });
}
