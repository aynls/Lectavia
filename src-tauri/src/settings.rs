use crate::error::AppError;
use keyring::Entry;
use serde::{Deserialize, Serialize};
#[cfg(feature = "desktop")]
use tauri::AppHandle;

pub const APP_IDENTIFIER: &str = env!("LECTAVIA_APP_IDENTIFIER");

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnection {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_effort: Option<String>,
}

impl ModelConnection {
    pub fn selected_reasoning_effort(&self) -> Option<&str> {
        self.reasoning_effort
            .as_ref()
            .filter(|effort| {
                self.reasoning_efforts
                    .as_ref()
                    .is_some_and(|supported| supported.contains(effort))
            })
            .map(String::as_str)
    }
}

#[derive(Deserialize, Serialize)]
pub struct ModelSettings {
    pub asr: ModelConnection,
    pub llm: ModelConnection,
}

fn model_entry(identifier: &str) -> Result<Entry, keyring::Error> {
    Entry::new(identifier, "model-settings-v1")
}

pub async fn read_model_settings(identifier: String) -> Result<Option<ModelSettings>, AppError> {
    tokio::task::spawn_blocking(move || {
        let entry = model_entry(&identifier).map_err(|_| "error.loadModelSettings")?;
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

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn load_model_settings(app: AppHandle) -> Result<Option<ModelSettings>, AppError> {
    read_model_settings(app.config().identifier.clone()).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn save_model_settings(app: AppHandle, settings: ModelSettings) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let entry = model_entry(&app.config().identifier).map_err(|_| "error.saveModelSettings")?;
        let secret = serde_json::to_vec(&settings).map_err(|_| "error.saveModelSettings")?;
        entry
            .set_secret(&secret)
            .map_err(|_| "error.saveModelSettings")
    })
    .await
    .map_err(|_| "error.saveModelSettings")?
    .map_err(AppError::from)
}
