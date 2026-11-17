import { useRef, useState, type SubmitEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "./Icon";
import { inspectMedia, type MediaInfo } from "./media";
import {
  defaultModelSettings,
  ModelSettings,
  type ModelSettingsValue,
} from "./ModelSettings";
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
  const [settings, setSettings] = useState<ModelSettingsValue | null>(null);
  const [justQueued, setJustQueued] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const previewKey = useRef("");
  const selected = new Set(selectedParts);
  const nextStep = justQueued
    ? "已加入队列，可以继续添加视频。"
    : previewing
      ? ""
      : !media
        ? "添加视频后即可开始。"
        : selected.size === 0
          ? "请至少选择一个分 P。"
          : !folder
            ? "请先选择保存目录。"
            : !settings
              ? "请先在右上角配置模型。"
              : "";

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
    setJustQueued(false);
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
    setFormError("");
    try {
      const path = await open({
        title: "选择输出目录",
        directory: true,
        multiple: false,
      });
      if (path) setFolder(path);
    } catch {
      setFormError("无法打开目录选择窗口。");
    }
  }

  async function choosePrompt() {
    setFormError("");
    try {
      const file = await invoke<PromptFile | null>("choose_prompt_file");
      if (file) setPrompt(file);
    } catch (error) {
      setFormError(String(error instanceof Error ? error.message : error));
    }
  }

  function removeVideo() {
    setLink("");
    clearPreview();
    linkInput.current?.focus();
  }

  function generate() {
    if (!media || !selected.size || !folder || !settings) return;

    setFormError("");
    queue.enqueue({
      media,
      parts: media.parts.filter((part) => selected.has(part.id)),
      outputDirectory: folder,
      format,
      instructions: prompt?.content,
      ...settings,
    });
    removeVideo();
    setJustQueued(true);
  }

  return (
    <>
      <header className="top-bar">
        <div className="app-width app-header">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="book" />
            </span>
            Lectavia
          </div>
          <ModelSettings
            value={settings ?? defaultModelSettings}
            configured={settings !== null}
            onSave={(next) => {
              setSettings(next);
              setFormError("");
            }}
          />
        </div>
      </header>
      <main className="app-width">
        <div className="workspace-title">
          <h1>视频转文稿</h1>
          <p>将视频中的语音转写、整理为 Markdown 或纯文本。</p>
        </div>
        {!desktop && (
          <p className="notice">请在 Lectavia 桌面应用中处理视频。</p>
        )}
        <div className="workspace">
          <section className="panel composer" aria-label="生成文稿">
            <section
              className="composer-section"
              aria-labelledby="input-heading"
            >
              <h2 id="input-heading">
                <Icon name="video" />
                视频来源
              </h2>
              <form onSubmit={submitLink} noValidate>
                <label className="sr-only" htmlFor="video-url">
                  视频链接
                </label>
                <div className="link-row">
                  <div className="link-field">
                    <Icon name="link" />
                    <input
                      ref={linkInput}
                      id="video-url"
                      name="video-url"
                      type="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="粘贴视频链接"
                      value={link}
                      disabled={!desktop}
                      aria-invalid={Boolean(link && sourceError)}
                      aria-describedby={
                        link && sourceError ? "source-error" : undefined
                      }
                      onBlur={() => previewLink(link)}
                      onChange={(event) => {
                        setLink(event.target.value);
                        clearPreview();
                        setJustQueued(false);
                      }}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!desktop || !link.trim() || previewing}
                  >
                    {previewing && link ? "读取中…" : "读取链接"}
                  </button>
                </div>
              </form>
              <button
                type="button"
                className="quiet local-video"
                onClick={chooseVideo}
                disabled={!desktop}
              >
                <Icon name="folder" />
                选择本地视频
              </button>
              {previewing && (
                <p className="source-status muted" role="status">
                  正在读取视频信息…
                </p>
              )}
              {sourceError && (
                <p id="source-error" className="error" role="alert">
                  {sourceError}
                </p>
              )}
              {media && (
                <div className="media enter" key={previewKey.current}>
                  <div className="media-heading">
                    {media.thumbnail && (
                      <img
                        src={media.thumbnail}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    )}
                    {!media.thumbnail && (
                      <span className="media-fallback">
                        <Icon name="video" />
                      </span>
                    )}
                    <div className="media-title">
                      <h3>{media.title}</h3>
                      {media.uploader && (
                        <p className="muted">{media.uploader}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="quiet icon-button"
                      aria-label="移除视频"
                      title="移除视频"
                      onClick={removeVideo}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                  {media.multipart && (
                    <fieldset className="parts">
                      <legend>选择分 P</legend>
                      <div className="parts-heading">
                        <p className="muted" role="status">
                          已选 {selected.size} / {media.parts.length} 集
                        </p>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() =>
                            setSelectedParts(
                              selected.size === media.parts.length
                                ? []
                                : media.parts.map((part) => part.id),
                            )
                          }
                        >
                          {selected.size === media.parts.length
                            ? "取消全选"
                            : "全选"}
                        </button>
                      </div>
                      <div className="parts-list">
                        {media.parts.map((part) => (
                          <label className="checkbox" key={part.id}>
                            <input
                              type="checkbox"
                              checked={selected.has(part.id)}
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
                      </div>
                    </fieldset>
                  )}
                </div>
              )}
            </section>
            <section
              className="composer-section"
              aria-labelledby="output-heading"
            >
              <h2 id="output-heading">
                <Icon name="folder" />
                保存设置
              </h2>
              <div className="options">
                <div className="option">
                  <div className="option-label">
                    <span>保存位置</span>
                    {folder && (
                      <p className="file-path" title={folder}>
                        {folder}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={chooseFolder}
                    disabled={!desktop}
                  >
                    {folder ? "更改目录" : "选择目录"}
                  </button>
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
              </div>
              <details className="advanced">
                <summary>
                  <Icon name="down" />
                  自定义整理要求
                  <small className="advanced-selection" title={prompt?.name}>
                    {prompt?.name ?? "可选"}
                  </small>
                </summary>
                <div className="advanced-content">
                  <div className="actions">
                    <button
                      type="button"
                      onClick={choosePrompt}
                      disabled={!desktop}
                    >
                      {prompt ? "更换文件" : "选择 Markdown 文件"}
                    </button>
                    {prompt && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setPrompt(null)}
                      >
                        移除
                      </button>
                    )}
                  </div>
                </div>
              </details>
            </section>
            <div className="composer-footer">
              {formError && (
                <p className="error" role="alert">
                  {formError}
                </p>
              )}
              <p id="next-step" className="muted next-step" role="status">
                {desktop ? nextStep : ""}
              </p>
              <button
                type="button"
                className="primary generate"
                disabled={
                  !desktop ||
                  previewing ||
                  !media ||
                  !selected.size ||
                  !folder ||
                  !settings
                }
                aria-describedby="next-step"
                onClick={generate}
              >
                生成文稿
                <Icon name="arrow" />
              </button>
            </div>
          </section>
          <TaskList queue={queue} />
        </div>
      </main>
    </>
  );
}
