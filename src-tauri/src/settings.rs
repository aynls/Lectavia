use std::{io, path::PathBuf};

use crate::error::AppError;
use keyring::Entry;
use serde::{Deserialize, Serialize};
#[cfg(feature = "desktop")]
use tauri::AppHandle;

pub const APP_IDENTIFIER: &str = env!("LECTAVIA_APP_IDENTIFIER");
const DEFAULT_AUDIO_CHUNK_SECONDS: &str = "1200";
const MIN_AUDIO_CHUNK_SECONDS: u64 = 60;

pub struct AudioChunkSeconds(String);

impl AudioChunkSeconds {
    fn parse(value: &str) -> Result<Self, AppError> {
        let seconds = value.trim().trim_start_matches('0');
        if seconds.is_empty()
            || !seconds.bytes().all(|digit| digit.is_ascii_digit())
            || seconds
                .parse::<u64>()
                .is_ok_and(|value| value < MIN_AUDIO_CHUNK_SECONDS)
        {
            return Err("settings.invalidAudioChunkSeconds".into());
        }
        Ok(Self(seconds.to_owned()))
    }

    pub fn ffmpeg_segment_time(&self) -> Option<&str> {
        // FFmpeg represents segment durations as signed 64-bit microseconds.
        // A longer interval cannot split an audio stream on that time scale.
        const MAX_SECONDS: u64 = i64::MAX as u64 / 1_000_000;
        self.0
            .parse::<u64>()
            .ok()
            .filter(|&seconds| seconds <= MAX_SECONDS)
            .map(|_| self.0.as_str())
    }
}

fn audio_chunk_seconds_path() -> Result<PathBuf, AppError> {
    dirs::config_dir()
        .map(|dir| dir.join(APP_IDENTIFIER).join("audio-chunk-seconds"))
        .ok_or_else(|| "error.loadAudioChunkSeconds".into())
}

pub async fn read_audio_chunk_seconds() -> Result<AudioChunkSeconds, AppError> {
    match tokio::fs::read_to_string(audio_chunk_seconds_path()?).await {
        Ok(value) => AudioChunkSeconds::parse(&value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(AudioChunkSeconds(DEFAULT_AUDIO_CHUNK_SECONDS.to_owned()))
        }
        Err(_) => Err("error.loadAudioChunkSeconds".into()),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn load_audio_chunk_seconds() -> Result<String, AppError> {
    Ok(read_audio_chunk_seconds().await?.0)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn save_audio_chunk_seconds(seconds: String) -> Result<String, AppError> {
    use std::{fs, io::Write};

    let seconds = AudioChunkSeconds::parse(&seconds)?.0;
    let path = audio_chunk_seconds_path().map_err(|_| "error.saveAudioChunkSeconds")?;
    tokio::task::spawn_blocking(move || {
        let directory = path.parent().expect("settings file has a parent directory");
        fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(seconds.as_bytes())?;
        file.persist(path).map_err(|error| error.error)?;
        Ok::<_, io::Error>(seconds)
    })
    .await
    .map_err(|_| "error.saveAudioChunkSeconds")?
    .map_err(|_| "error.saveAudioChunkSeconds".into())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnection {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_effort: Option<String>,
}

impl ModelConnection {
    pub fn is_configured(&self) -> bool {
        !self.base_url.trim().is_empty() && self.has_credentials()
    }

    fn has_credentials(&self) -> bool {
        !self.api_key.trim().is_empty() && !self.model.trim().is_empty()
    }

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

#[derive(Clone, Copy, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AsrProvider {
    ElevenLabs,
    Groq,
    OpenAi,
    OpenRouter,
    #[default]
    Custom,
}

#[derive(Deserialize, Serialize)]
pub struct AsrConnection {
    #[serde(default)]
    pub provider: AsrProvider,
    #[serde(flatten)]
    pub connection: ModelConnection,
}

impl AsrConnection {
    pub fn is_configured(&self) -> bool {
        if self.provider == AsrProvider::Custom {
            self.connection.is_configured()
        } else {
            self.connection.has_credentials()
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct ModelSettings {
    pub asr: AsrConnection,
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
