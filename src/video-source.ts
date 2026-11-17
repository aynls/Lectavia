export type VideoSource =
  | { kind: "bilibili" | "youtube"; url: string }
  | { kind: "local"; path: string };

export function parseVideoLink(input: string): VideoSource | null {
  const value = input.trim();
  const source = parseHttpsVideoLink(value);
  if (source) return source;

  const start = value.indexOf("https://");
  return start > 0 ? parseHttpsVideoLink(value.slice(start)) : null;
}

function parseHttpsVideoLink(value: string): VideoSource | null {
  const url = URL.parse(value);

  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "bilibili.com" ||
    host.endsWith(".bilibili.com") ||
    host === "b23.tv"
  ) {
    return { kind: "bilibili", url: url.href };
  }

  if (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  ) {
    return { kind: "youtube", url: url.href };
  }

  return null;
}
