use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

use crate::error::AppError;
use serde::Deserialize;
use tauri_plugin_opener::OpenerExt;
use tempfile::NamedTempFile;

const MAX_TITLE_UNITS: usize = 100;

fn safe_title(title: &str) -> Option<String> {
    let mut name = String::new();
    let mut units = 0;

    for character in title.trim().chars() {
        let character = if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
            '_'
        } else {
            character
        };

        units += character.len_utf16();
        if units > MAX_TITLE_UNITS {
            break;
        }
        name.push(character);
    }

    let name = name.trim_end_matches([' ', '.']);
    if name.is_empty() {
        return None;
    }

    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let numbered_device = device
        .strip_prefix("COM")
        .or_else(|| device.strip_prefix("LPT"))
        .is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });

    if numbered_device
        || matches!(
            device.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
    {
        Some(format!("_{name}"))
    } else {
        Some(name.into())
    }
}

fn output_title(title: &str, fallback: &str) -> String {
    safe_title(title)
        .or_else(|| safe_title(fallback))
        .unwrap_or_else(|| "Lectavia".into())
}

fn selected_directory(path: &str) -> Result<&Path, AppError> {
    let directory = Path::new(path);
    if directory.is_absolute() && directory.is_dir() {
        Ok(directory)
    } else {
        Err("error.folderInvalid".into())
    }
}

#[tauri::command]
pub async fn default_output_directory(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri::Manager;

    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| AppError::detail("error.defaultFolderLocation", error))?;
    let directory = base.join("Lectavia");
    fs::create_dir_all(&directory)
        .map_err(|error| AppError::detail("error.defaultFolderCreate", error))?;
    validate_output_directory(directory.to_string_lossy().into_owned()).await
}

#[tauri::command]
pub async fn validate_output_directory(directory: String) -> Result<String, AppError> {
    let directory = selected_directory(&directory)?;
    NamedTempFile::new_in(directory)
        .map_err(|error| AppError::detail("error.folderNotWritable", error))?;
    Ok(directory.to_string_lossy().into_owned())
}

fn candidate(directory: &Path, stem: &str, extension: &str, number: usize) -> PathBuf {
    if number == 1 {
        directory.join(format!("{stem}{extension}"))
    } else {
        directory.join(format!("{stem} ({number}){extension}"))
    }
}

fn already_present(error: &io::Error, path: &Path) -> bool {
    error.kind() == io::ErrorKind::AlreadyExists
        || (error.kind() == io::ErrorKind::PermissionDenied && path.symlink_metadata().is_ok())
}

#[tauri::command]
pub async fn create_output_directory(
    directory: String,
    title: String,
    fallback_title: String,
) -> Result<String, AppError> {
    let directory = selected_directory(&directory)?;
    let title = output_title(&title, &fallback_title);
    let mut number = 1;

    loop {
        let path = candidate(directory, &title, "", number);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path.to_string_lossy().into_owned()),
            Err(error) if already_present(&error, &path) => number += 1,
            Err(error) => return Err(AppError::detail("error.folderCreate", error)),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLabels {
    fallback_title: String,
    document_suffix: String,
}

#[tauri::command]
pub async fn write_output(
    directory: String,
    title: String,
    format: String,
    content: String,
    part_index: Option<u32>,
    labels: OutputLabels,
) -> Result<String, AppError> {
    let directory = selected_directory(&directory)?;
    let extension = match format.as_str() {
        "md" => ".md",
        "txt" => ".txt",
        _ => return Err("error.outputFormat".into()),
    };
    if content.trim().is_empty() {
        return Err("error.emptyOutput".into());
    }

    let title = output_title(&title, &labels.fallback_title);
    let suffix = output_title(&labels.document_suffix, &labels.fallback_title);
    let stem = match part_index {
        Some(number) => format!("P{number:02}-{title}-{suffix}"),
        None => format!("{title}-{suffix}"),
    };

    // Finish writing beside the final file before publishing it without replacing existing files.
    let mut pending = NamedTempFile::new_in(directory)
        .map_err(|error| AppError::detail("error.outputTemp", error))?;
    pending
        .write_all(content.as_bytes())
        .and_then(|()| pending.as_file().sync_all())
        .map_err(|error| AppError::detail("error.outputWrite", error))?;

    let mut number = 1;
    loop {
        let path = candidate(directory, &stem, extension, number);
        match pending.persist_noclobber(&path) {
            Ok(_) => return Ok(path.to_string_lossy().into_owned()),
            Err(error) if already_present(&error.error, &path) => {
                pending = error.file;
                number += 1;
            }
            Err(error) => return Err(AppError::detail("error.outputSave", error.error)),
        }
    }
}

#[tauri::command]
pub async fn reveal_output(
    app: tauri::AppHandle,
    path: String,
    is_directory: bool,
) -> Result<(), AppError> {
    let target = Path::new(&path);
    if !target.is_absolute()
        || !(if is_directory {
            target.is_dir()
        } else {
            target.is_file()
        })
    {
        return Err("error.outputGone".into());
    }

    let opener = app.opener();
    let result = if is_directory {
        opener.open_path(path, None::<&str>)
    } else {
        opener.reveal_item_in_dir(target)
    };

    result.map_err(|error| AppError::detail("error.outputReveal", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_reserved_and_long_windows_names() {
        assert_eq!(output_title(" coN.资料 ", "视频"), "_coN.资料");
        assert_eq!(output_title("LPT²", "视频"), "_LPT²");
        assert_eq!(output_title("课程/中文:提纲?.", "视频"), "课程_中文_提纲_");
        assert_eq!(output_title("...", "视频"), "视频");
        assert_eq!(
            output_title(&"📝".repeat(100), "视频")
                .encode_utf16()
                .count(),
            MAX_TITLE_UNITS
        );
    }

    #[test]
    fn validates_output_directory_before_starting() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().to_string_lossy().into_owned();
            assert_eq!(
                validate_output_directory(directory.clone()).await.unwrap(),
                directory
            );

            let missing = root.path().join("missing").to_string_lossy().into_owned();
            assert!(validate_output_directory(missing).await.is_err());
        });
    }

    #[test]
    fn writes_multipart_outputs_without_overwriting() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().to_string_lossy().into_owned();
            let title = "课程".to_owned();
            let labels = || OutputLabels {
                fallback_title: "视频".into(),
                document_suffix: "文稿".into(),
            };
            let folder = create_output_directory(directory.clone(), title.clone(), "视频".into())
                .await
                .unwrap();
            let second = create_output_directory(directory, title.clone(), "视频".into())
                .await
                .unwrap();
            assert!(second.ends_with("课程 (2)"));
            let first_file = write_output(
                folder.clone(),
                title.clone(),
                "md".into(),
                "初稿".into(),
                Some(2),
                labels(),
            )
            .await
            .unwrap();
            let second_file =
                write_output(folder, title, "md".into(), "新稿".into(), Some(2), labels())
                    .await
                    .unwrap();
            assert!(first_file.ends_with("P02-课程-文稿.md"));
            assert!(second_file.ends_with("P02-课程-文稿 (2).md"));
            assert_eq!(fs::read_to_string(first_file).unwrap(), "初稿");
            assert_eq!(fs::read_to_string(second_file).unwrap(), "新稿");
        });
    }
}
