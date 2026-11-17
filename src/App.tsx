import { useRef, useState, type SubmitEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { inspectMedia, type MediaInfo } from "./media";
import {
  defaultModelSettings,
  getModelConnections,
  ModelSettings,
} from "./ModelSettings";
import { validateModelConnection } from "./models";
import { TaskList } from "./TaskList";
import { TaskQueue } from "./tasks";
import { parseVideoLink, type VideoSource } from "./video-source";
import "./App.css";

interface PromptFile {
  name: string;
  content: string;
}

const queue = new TaskQueue();
const desktop = isTauri();

export default function App() {
  const [link, setLink] = useState("");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [selectedParts, setSelectedParts] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [formError, setFormError] = useState("");
  const [folder, setFolder] = useState("");
  const [format, setFormat] = useState<"md" | "txt">("md");
  const [prompt, setPrompt] = useState<PromptFile | null>(null);
  const [settings, setSettings] = useState(defaultModelSettings);
  const requestId = useRef(0);
  const previewKey = useRef("");

  function clearPreview() {
    requestId.current += 1;
    previewKey.current = "";
    setPreviewing(false);
    setMedia(null);
    setSelectedParts([]);
    setSourceError("");
  }

  async function preview(source: VideoSource) {
    const key = source.kind === "local" ? source.path : source.url;
    if (previewKey.current === key) return;

    clearPreview();
    setFormError("");
    const id = requestId.current;
    previewKey.current = key;
    setPreviewing(true);

    try {
      const info = await inspectMedia(source);
      if (id !== requestId.current) return;
      setMedia(info);
      const preferred =
        info.parts.find((part) => part.id === info.preferredPartId) ??
        info.parts[0];
      setSelectedParts(preferred ? [preferred.id] : []);
    } catch (error) {
      if (id !== requestId.current) return;
      previewKey.current = "";
      setSourceError(String(error instanceof Error ? error.message : error));
    } finally {
      if (id === requestId.current) setPreviewing(false);
    }
  }

  function previewLink(value: string) {
    if (!value.trim()) return;

    const source = parseVideoLink(value);
    if (!source) {
      setSourceError("请输入有效的 Bilibili 或 YouTube HTTPS 链接。");
      return;
    }
    void preview(source);
  }

  function submitLink(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    previewLink(link);
  }

  async function chooseVideo() {
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
        setLink("");
        void preview({ kind: "local", path });
      }
    } catch {
      setSourceError("无法打开视频选择窗口。");
    }
  }

  async function chooseFolder() {
    try {
      const path = await open({
        title: "选择输出目录",
        directory: true,
        multiple: false,
      });
      if (path) {
        setFolder(path);
        setFormError("");
      }
    } catch {
      setFormError("无法打开目录选择窗口。");
    }
  }

  async function choosePrompt() {
    try {
      const file = await invoke<PromptFile | null>("choose_prompt_file");
      if (file) {
        setPrompt(file);
        setFormError("");
      }
    } catch (error) {
      setFormError(String(error instanceof Error ? error.message : error));
    }
  }

  function generate() {
    if (!media || selectedParts.length === 0) {
      setFormError("请先读取视频并选择要处理的分 P。");
      return;
    }
    if (!folder) {
      setFormError("请选择输出目录。");
      return;
    }

    const { asr, llm } = getModelConnections(settings);
    try {
      validateModelConnection(asr);
      validateModelConnection(llm);
    } catch {
      setFormError("请先在模型设置中填写有效的转写和整理模型。");
      return;
    }

    setFormError("");
    queue.enqueue({
      media,
      parts: media.parts.filter((part) => selectedParts.includes(part.id)),
      outputDirectory: folder,
      format,
      instructions: prompt?.content,
      asr,
      llm,
    });
    setLink("");
    clearPreview();
  }

  return (
    <main>
      <header className="app-header">
        <h1>Lectavia</h1>
        <ModelSettings
          value={settings}
          onSave={(next) => {
            setSettings(next);
            setFormError("");
          }}
        />
      </header>
      {!desktop && <p className="notice">请在 Lectavia 桌面应用中处理视频。</p>}
      <div className="workspace">
        <section className="panel" aria-labelledby="input-heading">
          <h2 id="input-heading">添加视频</h2>
          <form onSubmit={submitLink}>
            <label htmlFor="video-url">视频链接</label>
            <div className="link-row">
              <input
                id="video-url"
                name="video-url"
                type="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Bilibili 或 YouTube 链接"
                value={link}
                disabled={!desktop}
                onBlur={() => previewLink(link)}
                onChange={(event) => {
                  setLink(event.target.value);
                  clearPreview();
                }}
              />
              <button type="submit" disabled={!desktop || !link.trim()}>
                读取链接
              </button>
            </div>
          </form>
          <button type="button" onClick={chooseVideo} disabled={!desktop}>
            选择本地视频
          </button>
          {previewing && (
            <p className="muted" role="status">
              正在读取视频信息…
            </p>
          )}
          {sourceError && (
            <p className="error" role="alert">
              {sourceError}
            </p>
          )}
          {media && (
            <div className="media">
              <div className="media-heading">
                {media.thumbnail && (
                  <img
                    src={media.thumbnail}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                )}
                <div>
                  <h3>{media.title}</h3>
                  {media.uploader && <p className="muted">{media.uploader}</p>}
                </div>
              </div>
              {media.multipart && (
                <fieldset className="parts">
                  <legend>选择分 P</legend>
                  {media.parts.map((part) => (
                    <label className="checkbox" key={part.id}>
                      <input
                        type="checkbox"
                        checked={selectedParts.includes(part.id)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelectedParts((current) =>
                            checked
                              ? [...current, part.id]
                              : current.filter((id) => id !== part.id),
                          );
                        }}
                      />
                      {part.number ? `P${part.number} · ` : ""}
                      {part.title}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          )}

          <div className="options">
            <div className="option">
              <span>输出目录</span>
              <button type="button" onClick={chooseFolder} disabled={!desktop}>
                {folder ? "更改目录" : "选择目录"}
              </button>
              {folder && <p className="file-path">{folder}</p>}
            </div>
            <div className="option">
              <label htmlFor="output-format">输出格式</label>
              <select
                id="output-format"
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value === "txt" ? "txt" : "md")
                }
              >
                <option value="md">Markdown (.md)</option>
                <option value="txt">纯文本 (.txt)</option>
              </select>
            </div>
            <div className="option">
              <span>
                自定义整理要求 <small>可选</small>
              </span>
              <button type="button" onClick={choosePrompt} disabled={!desktop}>
                {prompt ? "更换 Markdown" : "选择 Markdown"}
              </button>
              {prompt && (
                <div className="actions file-path">
                  <span>{prompt.name}</span>
                  <button type="button" onClick={() => setPrompt(null)}>
                    移除
                  </button>
                </div>
              )}
            </div>
          </div>
          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}
          <button
            type="button"
            className="primary generate"
            disabled={!desktop || previewing}
            onClick={generate}
          >
            生成学习资料
          </button>
        </section>
        <TaskList queue={queue} />
      </div>
    </main>
  );
}
