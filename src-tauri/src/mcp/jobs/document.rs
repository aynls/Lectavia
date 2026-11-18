use std::{collections::HashMap, path::Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::PartInfo;
use crate::{
    error::AppError,
    locale::Locale,
    models::{OrganizationOptions, organize},
    output::{
        OutputFormat, OutputLabels, create_output_directory, validate_output_directory,
        write_output,
    },
    settings::{APP_IDENTIFIER, read_model_settings},
};

#[derive(Deserialize, JsonSchema, Serialize)]
pub(crate) struct DocumentOptions {
    /// Existing directory where the generated files should be saved.
    output_directory: String,
    /// md (default) or txt.
    format: Option<OutputFormat>,
    /// Language of built-in instructions and file labels. Defaults to zh-CN.
    locale: Option<Locale>,
    /// Target document language. Defaults to the specified locale.
    output_language: Option<String>,
    /// Additional instructions for organizing the document.
    instructions: Option<String>,
}

pub(super) struct Document {
    options: DocumentOptions,
    directories: Mutex<HashMap<String, String>>,
}

impl Document {
    pub fn new(options: DocumentOptions) -> Self {
        Self {
            options,
            directories: Default::default(),
        }
    }

    pub async fn destination(&self) -> Result<String, AppError> {
        if self.options.output_directory.trim().is_empty() {
            return Err("error.folderInvalid".into());
        }
        let path = std::path::absolute(&self.options.output_directory)
            .map_err(|e| AppError::detail("cli.path", e))?;
        validate_output_directory(path.to_string_lossy().into_owned()).await
    }

    pub async fn organize(&self, transcript: &str, info: &PartInfo) -> Result<String, AppError> {
        let settings = read_model_settings(APP_IDENTIFIER.to_owned())
            .await?
            .ok_or("mcp.llmSettings")?;
        if !settings.llm.is_configured() {
            return Err("mcp.llmSettings".into());
        }
        let options = OrganizationOptions {
            video_title: info.video_title.clone(),
            part_title: info.multipart.then(|| info.title.clone()),
            description: info.description.clone(),
            format: self.options.format.unwrap_or(OutputFormat::Md),
            locale: self.options.locale.unwrap_or(Locale::ZhCn),
            output_language: self.options.output_language.clone(),
            instructions: self.options.instructions.clone(),
        };
        organize(transcript, &settings.llm, &options).await
    }

    pub async fn save(&self, info: &PartInfo, text: &str) -> Result<String, AppError> {
        let locale = self.options.locale.unwrap_or(Locale::ZhCn);
        let mut directory = self.destination().await?;
        if info.multipart {
            let mut directories = self.directories.lock().await;
            match directories
                .get(&info.video_key)
                .filter(|path| Path::new(path).is_dir())
            {
                Some(folder) => directory = folder.clone(),
                None => {
                    directory = create_output_directory(
                        directory,
                        info.video_title.clone(),
                        locale.text("output.fallbackTitle").into(),
                    )
                    .await?;
                    directories.insert(info.video_key.clone(), directory.clone());
                }
            }
        }
        write_output(
            directory,
            info.title.clone(),
            self.options
                .format
                .unwrap_or(OutputFormat::Md)
                .as_str()
                .into(),
            text.to_owned(),
            info.number.filter(|_| info.multipart),
            OutputLabels {
                fallback_title: locale.text("output.fallbackTitle").into(),
                document_suffix: locale.text("output.suffix").into(),
            },
        )
        .await
    }
}
