use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

use tauri_plugin_opener::OpenerExt;
use tempfile::NamedTempFile;

const MAX_TITLE_UNITS: usize = 100;

fn safe_title(title: &str) -> String {
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
        return "视频".into();
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
        format!("_{name}")
    } else {
        name.into()
    }
}

fn selected_directory(path: &str) -> Result<&Path, String> {
    let directory = Path::new(path);
    if directory.is_absolute() && directory.is_dir() {
        Ok(directory)
    } else {
        Err("保存目录不存在或无法访问。".into())
    }
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
pub async fn create_output_directory(directory: String, title: String) -> Result<String, String> {
    let directory = selected_directory(&directory)?;
    let title = safe_title(&title);
    let mut number = 1;

    loop {
        let path = candidate(directory, &title, "", number);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path.to_string_lossy().into_owned()),
            Err(error) if already_present(&error, &path) => number += 1,
            Err(error) => return Err(format!("无法创建保存文件夹：{error}")),
        }
    }
}

#[tauri::command]
pub async fn write_output(
    directory: String,
    title: String,
    format: String,
    content: String,
    part_index: Option<u32>,
) -> Result<String, String> {
    let directory = selected_directory(&directory)?;
    let extension = match format.as_str() {
        "md" => ".md",
        "txt" => ".txt",
        _ => return Err("输出格式必须是 Markdown 或纯文本。".into()),
    };
    if content.trim().is_empty() {
        return Err("整理结果为空，无法保存。".into());
    }

    let title = safe_title(&title);
    let stem = match part_index {
        Some(number) => format!("P{number:02}-{title}-文稿"),
        None => format!("{title}-文稿"),
    };

    // Finish writing beside the final file before publishing it without replacing existing files.
    let mut pending = NamedTempFile::new_in(directory)
        .map_err(|error| format!("无法在保存目录内创建临时文件：{error}"))?;
    pending
        .write_all(content.as_bytes())
        .and_then(|()| pending.as_file().sync_all())
        .map_err(|error| format!("无法写入文稿：{error}"))?;

    let mut number = 1;
    loop {
        let path = candidate(directory, &stem, extension, number);
        match pending.persist_noclobber(&path) {
            Ok(_) => return Ok(path.to_string_lossy().into_owned()),
            Err(error) if already_present(&error.error, &path) => {
                pending = error.file;
                number += 1;
            }
            Err(error) => return Err(format!("无法保存文稿：{}", error.error)),
        }
    }
}

#[tauri::command]
pub async fn reveal_output(
    app: tauri::AppHandle,
    path: String,
    is_directory: bool,
) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.is_absolute()
        || !(if is_directory {
            target.is_dir()
        } else {
            target.is_file()
        })
    {
        return Err("生成的文件或文件夹已不存在。".into());
    }

    let opener = app.opener();
    let result = if is_directory {
        opener.open_path(path, None::<&str>)
    } else {
        opener.reveal_item_in_dir(target)
    };

    result.map_err(|error| format!("无法打开文件位置：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_reserved_and_long_windows_names() {
        assert_eq!(safe_title(" coN.资料 "), "_coN.资料");
        assert_eq!(safe_title("LPT²"), "_LPT²");
        assert_eq!(safe_title("课程/中文:提纲?."), "课程_中文_提纲_");
        assert_eq!(safe_title("..."), "视频");
        assert_eq!(
            safe_title(&"📝".repeat(100)).encode_utf16().count(),
            MAX_TITLE_UNITS
        );
    }

    #[test]
    fn writes_multipart_outputs_without_overwriting() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().to_string_lossy().into_owned();
            let title = "课程".to_owned();
            let folder = create_output_directory(directory.clone(), title.clone())
                .await
                .unwrap();
            let second = create_output_directory(directory, title.clone())
                .await
                .unwrap();
            assert!(second.ends_with("课程 (2)"));
            let first_file = write_output(
                folder.clone(),
                title.clone(),
                "md".into(),
                "初稿".into(),
                Some(2),
            )
            .await
            .unwrap();
            let second_file = write_output(folder, title, "md".into(), "新稿".into(), Some(2))
                .await
                .unwrap();
            assert!(first_file.ends_with("P02-课程-文稿.md"));
            assert!(second_file.ends_with("P02-课程-文稿 (2).md"));
            assert_eq!(fs::read_to_string(first_file).unwrap(), "初稿");
            assert_eq!(fs::read_to_string(second_file).unwrap(), "新稿");
        });
    }
}
