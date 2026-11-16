import { useState, type SubmitEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { parseVideoLink, type VideoSource } from "./video-source";
import "./App.css";

const desktop = isTauri();

export default function App() {
  const [source, setSource] = useState<VideoSource | null>(null);
  const [error, setError] = useState("");
  const [choosingFile, setChoosingFile] = useState(false);

  function useLink(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget).get("video-url");
    const next = typeof input === "string" ? parseVideoLink(input) : null;

    if (!next) {
      setError("请输入有效的 Bilibili 或 YouTube HTTPS 链接。");
      event.currentTarget.querySelector("input")?.focus();
      return;
    }

    setError("");
    setSource(next);
  }

  async function chooseVideo() {
    setError("");
    setChoosingFile(true);

    try {
      const path = await open({
        title: "选择本地视频",
        multiple: false,
        filters: [
          {
            name: "视频文件",
            extensions: ["mp4", "mkv", "webm", "mov", "m4v", "avi"],
          },
        ],
      });

      if (path) {
        setSource({ kind: "local", path });
      }
    } catch {
      setError("无法打开文件选择窗口，请重试。");
    } finally {
      setChoosingFile(false);
    }
  }

  return (
    <main>
      <h1>Lectavia</h1>
      <form onSubmit={useLink}>
        <label htmlFor="video-url">视频链接</label>
        <p id="video-hint">支持 Bilibili 和 YouTube。</p>
        <div className="link-row">
          <input
            id="video-url"
            name="video-url"
            type="url"
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="video-hint"
            onChange={() => setError("")}
          />
          <button type="submit">使用链接</button>
        </div>
      </form>
      {desktop && (
        <button type="button" onClick={chooseVideo} disabled={choosingFile}>
          选择本地视频
        </button>
      )}
      <p role="alert">{error}</p>
      <p role="status">
        {source && (
          <>已选择 {source.kind === "local" ? source.path : source.url}</>
        )}
      </p>
    </main>
  );
}
