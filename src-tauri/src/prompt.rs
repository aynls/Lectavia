use std::fs;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct PromptFile {
    name: String,
    content: String,
}

#[tauri::command]
pub async fn choose_prompt_file(app: AppHandle) -> Result<Option<PromptFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("选择整理要求")
            .add_filter("Markdown", &["md", "markdown"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };

        let path = file
            .into_path()
            .map_err(|_| "无法读取所选 Markdown 文件的路径。".to_string())?;
        let name = path
            .file_name()
            .ok_or("无法读取所选 Markdown 文件的名称。")?
            .to_string_lossy()
            .into_owned();
        let content = fs::read_to_string(path)
            .map_err(|error| format!("无法读取 UTF-8 Markdown 文件：{error}"))?;

        Ok(Some(PromptFile {
            name,
            content: content.trim_start_matches('\u{feff}').to_owned(),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}
