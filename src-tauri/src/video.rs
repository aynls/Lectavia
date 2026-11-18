use std::path::{self, PathBuf};

use reqwest::Url;
use serde_json::Value;

use crate::{
    error::AppError,
    media::{
        MediaSource, MediaTools, bilibili_id_query, fetch_bilibili_video, probe_video,
        remote_source, resolve_bilibili_short_link,
    },
};

pub struct Video {
    pub title: String,
    pub description: Option<String>,
    pub parts: Vec<VideoPart>,
    pub preferred_part: Option<u32>,
}

pub struct VideoPart {
    pub source: MediaSource,
    pub title: Option<String>,
    pub number: Option<u32>,
}

pub fn parse_source(input: PathBuf) -> Result<MediaSource, AppError> {
    if let Some(link) = input.to_str().filter(|text| text.contains("://")) {
        return remote_source(link);
    }
    let path = path::absolute(input).map_err(|error| AppError::detail("cli.path", error))?;
    if !path.is_file() {
        return Err("error.localVideoMissing".into());
    }
    Ok(MediaSource::Local { path })
}

pub fn choose_parts(video: Video, mut requested: Vec<u32>) -> Result<Vec<VideoPart>, AppError> {
    if requested.is_empty() {
        requested.extend(video.preferred_part);
    }
    if requested.is_empty() {
        return Ok(video.parts.into_iter().take(1).collect());
    }
    requested.sort_unstable();
    requested.dedup();
    for number in &requested {
        if !video.parts.iter().any(|part| part.number == Some(*number)) {
            return Err(AppError::from("cli.partMissing").with("number", *number));
        }
    }
    Ok(video
        .parts
        .into_iter()
        .filter(|part| {
            part.number
                .is_some_and(|number| requested.contains(&number))
        })
        .collect())
}

impl Video {
    fn single(title: String, source: MediaSource, description: Option<String>) -> Self {
        Self {
            title,
            description,
            parts: vec![VideoPart {
                source,
                title: None,
                number: None,
            }],
            preferred_part: None,
        }
    }
}

fn metadata_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn part_number(url: &Url) -> Option<u32> {
    url.query_pairs()
        .find(|(key, _)| key == "p")
        .and_then(|(_, value)| value.parse().ok())
        .filter(|number| *number > 0)
}

fn bilibili_part(parent: &Url, number: u32, title: Option<String>) -> VideoPart {
    let mut url = parent.clone();
    url.query_pairs_mut().append_pair("p", &number.to_string());
    VideoPart {
        source: MediaSource::Bilibili {
            url: url.to_string(),
        },
        title,
        number: Some(number),
    }
}

fn bilibili_details(response: &Value, parent: &Url) -> Option<Video> {
    if response["code"].as_i64() != Some(0) {
        return None;
    }
    let details = &response["data"];
    let title_text = metadata_text(&details["title"])?;
    let pages = details["pages"].as_array()?;
    let parts = pages
        .iter()
        .filter_map(|page| {
            let number = u32::try_from(page["page"].as_u64()?).ok()?;
            (number > 0).then(|| {
                let part_title = if pages.len() == 1 {
                    Some(title_text.clone())
                } else {
                    metadata_text(&page["part"])
                };
                bilibili_part(parent, number, part_title)
            })
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then_some(Video {
        title: title_text,
        description: metadata_text(&details["desc"]),
        parts,
        preferred_part: None,
    })
}

async fn probe_bilibili(tools: &MediaTools, parent: &Url) -> Result<Video, AppError> {
    let metadata = probe_video(tools, parent.to_string(), false, true).await?;
    let title_text = metadata_text(&metadata["title"]).ok_or("error.noVideoTitle")?;
    let parts = if let Some(entries) = metadata["entries"].as_array() {
        let parts = entries
            .iter()
            .filter_map(|entry| {
                let url = Url::parse(entry["url"].as_str()?).ok()?;
                let number = part_number(&url)?;
                Some(bilibili_part(
                    parent,
                    number,
                    metadata_text(&entry["title"]),
                ))
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return Err("error.unknownParts".into());
        }
        parts
    } else {
        vec![bilibili_part(parent, 1, None)]
    };
    let mut description = metadata_text(&metadata["description"]);
    if description.is_none()
        && let Some(VideoPart {
            source: MediaSource::Bilibili { url },
            ..
        }) = parts.first()
        && let Ok(info) = probe_video(tools, url.clone(), false, false).await
    {
        description = metadata_text(&info["description"]);
    }
    Ok(Video {
        title: title_text,
        description,
        parts,
        preferred_part: None,
    })
}

pub async fn inspect(tools: &MediaTools, source: MediaSource) -> Result<Video, AppError> {
    match source {
        MediaSource::Local { ref path } => {
            let name = path
                .file_stem()
                .ok_or("error.noVideoTitle")?
                .to_string_lossy()
                .into_owned();
            Ok(Video::single(name, source, None))
        }
        MediaSource::Youtube { ref url } => {
            let metadata = probe_video(tools, url.clone(), true, false).await?;
            if metadata["entries"].is_array()
                || matches!(
                    metadata["live_status"].as_str(),
                    Some("is_live" | "is_upcoming")
                )
            {
                return Err("error.publishedYoutubeRequired".into());
            }
            let title = metadata_text(&metadata["title"]).ok_or("error.noVideoTitle")?;
            Ok(Video::single(
                title,
                source,
                metadata_text(&metadata["description"]),
            ))
        }
        MediaSource::Bilibili { url } => {
            let mut url = Url::parse(&url).map_err(|_| "error.malformedVideoUrl")?;
            if url.host_str() == Some("b23.tv") {
                let resolved = resolve_bilibili_short_link(url.to_string()).await?;
                url = Url::parse(&resolved).map_err(|_| "error.malformedVideoUrl")?;
            }
            let preferred_part = part_number(&url);
            let id = url
                .path()
                .strip_prefix("/video/")
                .unwrap_or_default()
                .trim_end_matches('/');
            if bilibili_id_query(id).is_none() {
                return Err("error.bilibiliPostRequired".into());
            }
            let parent = Url::parse(&format!("https://www.bilibili.com/video/{id}"))
                .expect("validated Bilibili video identifier");
            let detail = fetch_bilibili_video(id.to_owned())
                .await
                .ok()
                .and_then(|response| bilibili_details(&response, &parent));
            let mut video = match detail {
                Some(detail) => detail,
                None => probe_bilibili(tools, &parent).await?,
            };
            video.parts.sort_by_key(|part| part.number);
            video.parts.dedup_by_key(|part| part.number);
            video.preferred_part = preferred_part;
            Ok(video)
        }
    }
}
