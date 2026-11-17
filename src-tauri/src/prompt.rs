use std::fs;

use crate::error::AppError;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct PromptFile {
    name: String,
    content: String,
}

#[tauri::command]
pub async fn choose_prompt_file(
    app: AppHandle,
    title: String,
    filter_name: String,
) -> Result<Option<PromptFile>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter_name, &["md", "markdown"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };

        let path = file.into_path().map_err(|_| "error.promptPath")?;
        let name = path
            .file_name()
            .ok_or("error.promptName")?
            .to_string_lossy()
            .into_owned();
        let content = fs::read_to_string(path)
            .map_err(|error| AppError::detail("error.promptRead", error))?;

        Ok(Some(PromptFile {
            name,
            content: content.trim_start_matches('\u{feff}').to_owned(),
        }))
    })
    .await
    .map_err(|error| AppError::detail("error.background", error))?
}
