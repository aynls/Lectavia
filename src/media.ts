import { invoke } from "@tauri-apps/api/core";
import type { VideoSource } from "./video-source";

export type MediaPart = {
  id: string;
  title: string;
  number?: number;
  source: VideoSource;
};

export type MediaInfo = {
  title: string;
  uploader?: string;
  thumbnail?: string;
  parts: MediaPart[];
  multipart: boolean;
  preferredPartId?: string;
};

export type AudioChunks = {
  directory: string;
  files: string[];
};

type BilibiliVideo = {
  code: number;
  data?: {
    bvid: string;
    title: string;
    pic?: string;
    owner?: { name?: string };
    pages?: { page: number; part?: string }[];
  };
};

type VideoProbe = {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  live_status?: string;
  entries?: { url?: string }[];
};

function thumbnailUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = URL.parse(value.startsWith("//") ? `https:${value}` : value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return undefined;
  }
  url.protocol = "https:";
  return url.href;
}

function ordinaryVideo(info: VideoProbe, source: VideoSource): MediaInfo {
  const title = info.title?.trim();
  if (!title) throw new Error("无法取得视频标题。");

  return {
    title,
    uploader: info.uploader || info.channel,
    thumbnail: thumbnailUrl(info.thumbnail),
    parts: [{ id: info.id ?? "video", title, source }],
    multipart: false,
  };
}

function previewUrl(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.delete("p");
  copy.hash = "";
  return copy.href;
}

function multipartVideo(
  info: Omit<MediaInfo, "parts" | "multipart" | "preferredPartId">,
  parts: MediaPart[],
  requestedPart: string | null,
): MediaInfo {
  const preferredPart = parts.find(
    (part) => part.number === Number(requestedPart),
  );
  return {
    ...info,
    parts: parts.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
    multipart: parts.length > 1,
    preferredPartId: preferredPart?.id,
  };
}

async function fallbackBilibili(url: URL, videoId: string): Promise<MediaInfo> {
  const parentUrl = previewUrl(url);
  const flat = await invoke<VideoProbe>("probe_remote_video", {
    url: parentUrl,
    youtube: false,
    flat: true,
  });
  const parts: MediaPart[] = [];
  for (const entry of flat.entries ?? []) {
    const partUrl = entry.url ? URL.parse(entry.url) : null;
    const number = Number(partUrl?.searchParams.get("p"));
    if (!partUrl || !Number.isSafeInteger(number) || number < 1) continue;

    parts.push({
      id: `${videoId}:${number}`,
      number,
      title: `第 ${number} P`,
      source: { kind: "bilibili", url: partUrl.href },
    });
  }

  const first = parts[0];
  if (!first || first.source.kind === "local") {
    if (flat.entries) throw new Error("无法识别视频的分 P 列表。");
    return ordinaryVideo(flat, { kind: "bilibili", url: parentUrl });
  }

  const firstInfo = await invoke<VideoProbe>("probe_remote_video", {
    url: first.source.url,
    youtube: false,
    flat: false,
  });
  return multipartVideo(
    {
      title: flat.title || firstInfo.title || videoId,
      uploader: firstInfo.uploader,
      thumbnail: thumbnailUrl(firstInfo.thumbnail),
    },
    parts,
    url.searchParams.get("p"),
  );
}

async function inspectBilibili(link: string): Promise<MediaInfo> {
  let url = new URL(link);
  if (url.hostname === "b23.tv") {
    url = new URL(
      await invoke<string>("resolve_bilibili_short_link", { url: url.href }),
    );
  }

  const videoId = /^\/video\/(BV[a-zA-Z0-9]{10}|av\d+)\/?$/.exec(
    url.pathname,
  )?.[1];
  if (!videoId) throw new Error("请输入 Bilibili 视频投稿链接。");

  let response: BilibiliVideo;
  try {
    response = await invoke<BilibiliVideo>("fetch_bilibili_video", { videoId });
  } catch {
    return fallbackBilibili(url, videoId);
  }
  const details = response.data;
  const pages = details?.pages;
  if (
    response.code !== 0 ||
    !details?.title ||
    !details.bvid ||
    !Array.isArray(pages)
  ) {
    return fallbackBilibili(url, videoId);
  }

  const canonical = `https://www.bilibili.com/video/${details.bvid}`;
  const parts = pages
    .filter(({ page }) => Number.isSafeInteger(page) && page > 0)
    .map<MediaPart>(({ page, part }) => ({
      id: `${details.bvid}:${page}`,
      number: page,
      title: pages.length === 1 ? details.title : part || `第 ${page} P`,
      source: { kind: "bilibili", url: `${canonical}?p=${page}` },
    }));
  if (!parts.length) return fallbackBilibili(url, videoId);

  return multipartVideo(
    {
      title: details.title,
      uploader: details.owner?.name,
      thumbnail: thumbnailUrl(details.pic),
    },
    parts,
    url.searchParams.get("p"),
  );
}

export async function inspectMedia(source: VideoSource): Promise<MediaInfo> {
  if (source.kind === "local") {
    const name = source.path.split(/[/\\]/).at(-1) ?? "";
    const title = name.replace(/\.[^.]+$/, "") || name;
    return ordinaryVideo({ id: "local", title }, source);
  }

  if (source.kind === "bilibili") return inspectBilibili(source.url);

  const info = await invoke<VideoProbe>("probe_remote_video", {
    url: source.url,
    youtube: true,
    flat: false,
  });
  if (
    info.entries ||
    info.live_status === "is_live" ||
    info.live_status === "is_upcoming"
  ) {
    throw new Error("请选择一个已经发布的 YouTube 视频。");
  }

  return ordinaryVideo(info, source);
}

export function prepareAudio(part: MediaPart): Promise<AudioChunks> {
  return invoke("prepare_media_audio", { source: part.source });
}

export function removeAudio(chunks: AudioChunks): Promise<void> {
  return invoke("remove_media_audio", { directory: chunks.directory });
}
