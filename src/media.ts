import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import type { VideoSource } from "./video-source";

type MediaPart = {
  id: string;
  title?: string;
  number?: number;
};

export type MediaInfo = {
  title: string;
  uploader?: string;
  thumbnail?: string;
  source: VideoSource;
  sourceUrl?: string;
  parts: MediaPart[];
  multipart: boolean;
  preferredPartId?: string;
};

export interface VideoPreview {
  title: string;
  uploader: string | null;
  thumbnail: string | null;
  preferred_part: number | null;
  parts: { number: number | null; title: string | null }[];
}

export function partLabel(
  part: Pick<MediaPart, "number" | "title">,
  t: TFunction,
): string {
  if (!part.number) return part.title ?? t("output.fallbackTitle");
  return part.title
    ? t("media.partLabel", { number: part.number, title: part.title })
    : t("media.part", { number: part.number });
}

export function sourceValue(source: VideoSource): string {
  return source.kind === "local" ? source.path : source.url;
}

export async function inspectMedia(source: VideoSource): Promise<MediaInfo> {
  const info = await invoke<VideoPreview>("inspect_task_video", {
    video: sourceValue(source),
  });
  return presentVideo(info, source);
}

export function presentVideo(
  info: VideoPreview,
  source: VideoSource,
): MediaInfo {
  const parts = info.parts.map((part, index) => ({
    id: String(part.number ?? index),
    number: part.number ?? undefined,
    title: part.title ?? undefined,
  }));
  return {
    title: info.title,
    uploader: info.uploader ?? undefined,
    thumbnail: info.thumbnail ?? undefined,
    source,
    sourceUrl: source.kind === "local" ? undefined : source.url,
    parts,
    multipart: parts.length > 1,
    preferredPartId:
      info.preferred_part === null ? undefined : String(info.preferred_part),
  };
}

export function chooseParts(
  media: MediaInfo,
  numbers?: number[] | null,
): string[] {
  if (numbers?.length) {
    return media.parts
      .filter((part) => part.number && numbers.includes(part.number))
      .map((part) => part.id);
  }
  const preferred =
    media.parts.find((part) => part.id === media.preferredPartId) ??
    media.parts[0];
  return preferred ? [preferred.id] : [];
}
