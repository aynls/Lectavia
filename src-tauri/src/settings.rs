use crate::error::AppError;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConnection {
    base_url: String,
    api_key: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct ModelSettings {
    asr: ModelConnection,
    llm: ModelConnection,
}

#[tauri::command]
pub async fn load_model_settings(app: AppHandle) -> Result<Option<ModelSettings>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(&app.config().identifier, "model-settings-v1")
            .map_err(|_| "error.loadModelSettings")?;
        match entry.get_secret() {
            Ok(secret) => serde_json::from_slice(&secret)
                .map(Some)
                .map_err(|_| "error.loadModelSettings"),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("error.loadModelSettings"),
        }
    })
    .await
    .map_err(|_| "error.loadModelSettings")?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn save_model_settings(app: AppHandle, settings: ModelSettings) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(&app.config().identifier, "model-settings-v1")
            .map_err(|_| "error.saveModelSettings")?;
        let secret = serde_json::to_vec(&settings).map_err(|_| "error.saveModelSettings")?;
        entry
            .set_secret(&secret)
            .map_err(|_| "error.saveModelSettings")
    })
    .await
    .map_err(|_| "error.saveModelSettings")?
    .map_err(AppError::from)
}
