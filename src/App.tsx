import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type SubmitEvent,
} from "react";
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

type SourceMode = "link" | "local";
type FolderStatus = "checking" | "ready" | "error";

const queue = new TaskQueue();
const desktop = isTauri();
const FOLDER_STORAGE_KEY = "lectavia.output-directory";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rememberedFolder(): string {
  try {
    return localStorage.getItem(FOLDER_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberFolder(path: string): void {
  try {
    localStorage.setItem(FOLDER_STORAGE_KEY, path);
  } catch {
    // The selected directory still works when storage is unavailable.
  }
}

export default function App() {
  const [sourceMode, setSourceMode] = useState<SourceMode>("link");
  const [link, setLink] = useState("");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [selectedParts, setSelectedParts] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [formError, setFormError] = useState("");
  const [folder, setFolder] = useState("");
  const [folderStatus, setFolderStatus] = useState<FolderStatus>(
    desktop ? "checking" : "error",
  );
  const [folderError, setFolderError] = useState("");
  const [format, setFormat] = useState<"md" | "txt">("md");
  const [instructions, setInstructions] = useState("");
  const [prompt, setPrompt] = useState<PromptFile | null>(null);
  const [settings, setSettings] = useState<ModelSettingsValue | null>(null);
  const [justQueued, setJustQueued] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const previewKey = useRef("");
  const selected = new Set(selectedParts);
  const localMedia = media?.parts[0]?.source.kind === "local";
  const folderReady = folderStatus === "ready" && Boolean(folder);
  const canGenerate = Boolean(
    desktop &&
    !previewing &&
    !queueing &&
    media &&
    selected.size &&
    folderReady &&
    settings,
  );

  const missing: string[] = [];
  if (!media) {
    missing.push(
      sourceError
        ? "修正视频链接"
        : sourceMode === "link" && link.trim()
          ? "解析视频链接"
          : "选择视频",
    );
  } else if (selected.size === 0) {
    missing.push("选择至少一个分 P");
  }
  if (!settings) missing.push("在右上角配置模型");
  if (folderStatus === "error" || (!folder && folderStatus !== "checking")) {
    missing.push("选择可用的保存目录");
  }

  const nextStep = justQueued
    ? "已加入任务队列，可以继续添加下一个视频。"
    : previewing
      ? "正在解析视频，确认标题和分 P 后即可生成。"
      : queueing
        ? "正在确认保存目录，随后加入任务队列。"
        : missing.length
          ? `还需：${missing.join("、")}。`
          : folderStatus === "checking"
            ? "正在准备默认保存目录。"
            : `已就绪，将生成 ${selected.size} 份${format === "md" ? " Markdown" : "纯文本"}文稿。`;

  useEffect(() => {
    if (!desktop) return;

    let active = true;
    async function prepareFolder() {
      const previous = rememberedFolder();
      if (previous) {
        try {
          await invoke("validate_output_directory", { directory: previous });
          if (!active) return;
          setFolder(previous);
          setFolderStatus("ready");
          return;
        } catch {
          // An unavailable previous directory falls back to the default.
        }
      }

      try {
        const path = await invoke<string>("default_output_directory");
        if (!active) return;
        setFolder(path);
        setFolderStatus("ready");
        setFolderError("");
        rememberFolder(path);
      } catch {
        if (!active) return;
        setFolderStatus("error");
        setFolderError("无法准备默认保存目录，请手动选择。");
      }
    }

    void prepareFolder();
    return () => {
      active = false;
    };
  }, []);

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
      setSourceError(errorMessage(error));
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

  function changeLink(value: string) {
    setLink(value);
    clearPreview();
    setJustQueued(false);
  }

  function pasteLink(event: ClipboardEvent<HTMLInputElement>) {
    const value = event.clipboardData.getData("text");
    const source = parseVideoLink(value);
    if (!source) return;

    event.preventDefault();
    setLink(value);
    void preview(source);
  }

  function submitLink(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    previewLink(link);
  }

  function switchSource(mode: SourceMode) {
    if (mode === sourceMode) return;
    setSourceMode(mode);
    setLink("");
    clearPreview();
    setFormError("");
    setJustQueued(false);
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
    setFolderError("");
    try {
      const path = await open({
        title: "选择输出目录",
        directory: true,
        multiple: false,
        defaultPath: folder || undefined,
      });
      if (!path) return;

      setFolderStatus("checking");
      try {
        await invoke("validate_output_directory", { directory: path });
        setFolder(path);
        setFolderStatus("ready");
        rememberFolder(path);
      } catch (error) {
        setFolderStatus(folder ? "ready" : "error");
        setFolderError(`${errorMessage(error)} 请重新选择保存目录。`);
      }
    } catch {
      setFolderStatus(folder ? "ready" : "error");
      setFolderError("无法打开目录选择窗口。");
    }
  }

  async function choosePrompt() {
    setFormError("");
    try {
      const file = await invoke<PromptFile | null>("choose_prompt_file");
      if (file) setPrompt(file);
    } catch (error) {
      setFormError(errorMessage(error));
    }
  }

  function removeVideo() {
    setLink("");
    clearPreview();
    if (sourceMode === "link") linkInput.current?.focus();
  }

  async function generate() {
    if (!canGenerate || !media || !settings) return;

    setFormError("");
    setFolderError("");
    setQueueing(true);
    try {
      await invoke("validate_output_directory", { directory: folder });
      const customInstructions = [
        instructions.trim(),
        prompt?.content.trim() ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");

      queue.enqueue({
        media,
        parts: media.parts.filter((part) => selected.has(part.id)),
        outputDirectory: folder,
        format,
        instructions: customInstructions || undefined,
        ...settings,
      });
      rememberFolder(folder);
      removeVideo();
      setJustQueued(true);
    } catch (error) {
      setFolderStatus("error");
      setFolderError("保存目录不可用，请重新选择。");
      setFormError(`无法开始生成：${errorMessage(error)}`);
    } finally {
      setQueueing(false);
    }
  }

  return (
    <>
      <header className="top-bar">
        <div className="app-width app-header">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="waveform" />
            </span>
            Lectavia
          </div>
          <ModelSettings
            value={settings ?? defaultModelSettings}
            configured={settings !== null}
            onSave={(next) => {
              setSettings(next);
              setFormError("");
              setJustQueued(false);
            }}
          />
        </div>
      </header>
      <main className="app-width">
        {!desktop && (
          <p className="notice">请在 Lectavia 桌面应用中处理视频。</p>
        )}
        <div className="workspace-title">
          <div>
            <h1 id="workspace-title">视频转文稿</h1>
            <p>转写并整理视频内容，保存为可编辑的 Markdown 或纯文本。</p>
          </div>
          <div className="signal-script" aria-hidden="true">
            <div className="signal-bars">
              {Array.from({ length: 9 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
            <Icon name="arrow" />
            <div className="script-lines">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
        <div className="workspace">
          <section className="composer" aria-labelledby="workspace-title">
            <section className="source-section" aria-labelledby="input-heading">
              <div className="section-heading">
                <h2 id="input-heading">选择视频</h2>
                <p>一种来源，一份文稿。链接和本地文件不会混用。</p>
              </div>
              <div className="source-tabs" role="tablist" aria-label="视频来源">
                <button
                  id="link-tab"
                  type="button"
                  role="tab"
                  aria-selected={sourceMode === "link"}
                  aria-controls="source-panel"
                  data-active={sourceMode === "link"}
                  onClick={() => switchSource("link")}
                >
                  <Icon name="link" />
                  粘贴链接
                </button>
                <button
                  id="local-tab"
                  type="button"
                  role="tab"
                  aria-selected={sourceMode === "local"}
                  aria-controls="source-panel"
                  data-active={sourceMode === "local"}
                  onClick={() => switchSource("local")}
                >
                  <Icon name="video" />
                  本地文件
                </button>
              </div>
              <div
                id="source-panel"
                className="source-panel"
                role="tabpanel"
                aria-labelledby={
                  sourceMode === "link" ? "link-tab" : "local-tab"
                }
              >
                {sourceMode === "link" ? (
                  <form onSubmit={submitLink} noValidate>
                    <label className="source-label" htmlFor="video-url">
                      Bilibili 或 YouTube 链接
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
                          placeholder="粘贴链接后自动解析"
                          value={link}
                          disabled={!desktop}
                          aria-invalid={Boolean(link && sourceError)}
                          aria-describedby={
                            link && sourceError ? "source-error" : "source-hint"
                          }
                          onBlur={() => previewLink(link)}
                          onPaste={pasteLink}
                          onChange={(event) => changeLink(event.target.value)}
                        />
                      </div>
                      <button
                        type="submit"
                        className="parse-button"
                        disabled={!desktop || !link.trim() || previewing}
                      >
                        {previewing ? "解析中…" : "解析链接"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="local-picker"
                    onClick={chooseVideo}
                    disabled={!desktop}
                  >
                    <span className="local-picker-icon">
                      <Icon name="video" />
                    </span>
                    <span className="local-picker-copy">
                      <strong>
                        {localMedia ? "重新选择视频文件" : "选择视频文件"}
                      </strong>
                      <small>MP4、MKV、WebM、MOV、M4V、AVI</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                )}
                <p id="source-hint" className="source-hint">
                  {sourceMode === "link"
                    ? "解析用于确认标题和分 P；完成后，点击「生成文稿」即可。"
                    : "选择文件后会显示视频名称，确认后即可生成文稿。"}
                </p>
              </div>
              {previewing && (
                <div
                  className="media media-loading media-heading enter"
                  role="status"
                >
                  <span className="media-fallback" aria-hidden="true" />
                  <div className="media-title">
                    <p className="muted">正在读取视频标题和分 P…</p>
                    <span className="skeleton-line" aria-hidden="true" />
                  </div>
                </div>
              )}
              {sourceError && (
                <p
                  id="source-error"
                  className="error source-error"
                  role="alert"
                >
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
                      <p className="media-ready">
                        <Icon name="check" />
                        已解析，可生成
                      </p>
                      <h3>{media.title}</h3>
                      <p className="muted">
                        {media.uploader ??
                          (localMedia
                            ? "本地视频"
                            : `${media.parts.length} 个视频分段`)}
                      </p>
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
              className="output-section"
              aria-labelledby="output-heading"
            >
              <div className="section-heading">
                <h2 id="output-heading">文稿设置</h2>
                <p>确定保存位置，并告诉模型如何整理内容。</p>
              </div>
              <div className="options">
                <div className="option">
                  <span className="option-label">保存位置</span>
                  <button
                    type="button"
                    className="directory-choice"
                    aria-label={
                      folder ? `更改保存位置，当前为 ${folder}` : "选择保存位置"
                    }
                    title={folder || undefined}
                    onClick={chooseFolder}
                    disabled={!desktop}
                  >
                    <Icon name="folder" />
                    <span>
                      {folder ||
                        (folderStatus === "checking"
                          ? "正在准备默认目录…"
                          : "选择保存目录")}
                    </span>
                    <Icon name="down" />
                  </button>
                  {folderError && (
                    <p className="error field-error" role="alert">
                      {folderError}
                    </p>
                  )}
                </div>
                <div className="option">
                  <label htmlFor="output-format">文件格式</label>
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
              <div className="instructions-field">
                <div className="field-label-row">
                  <label htmlFor="custom-instructions">整理要求</label>
                  <span>可选</span>
                </div>
                <textarea
                  id="custom-instructions"
                  rows={4}
                  value={instructions}
                  aria-describedby="instructions-hint"
                  placeholder="例如：按主题分节，保留关键术语，并在末尾列出复习问题。"
                  onChange={(event) => setInstructions(event.target.value)}
                />
                <p id="instructions-hint" className="field-hint">
                  直接填写即可，也可以导入 Markdown 文件一起补充。
                </p>
                <div className="prompt-import">
                  <button
                    type="button"
                    className="quiet import-prompt"
                    onClick={choosePrompt}
                    disabled={!desktop}
                  >
                    <Icon name="upload" />
                    {prompt ? "更换 Markdown 文件" : "导入 Markdown 文件"}
                  </button>
                  {prompt && (
                    <div className="prompt-file">
                      <Icon name="document" />
                      <span title={prompt.name}>{prompt.name}</span>
                      <button
                        type="button"
                        className="quiet icon-button"
                        aria-label={`移除 ${prompt.name}`}
                        onClick={() => setPrompt(null)}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </section>
          </section>
          <div className="side-rail">
            <section className="action-panel" aria-label="生成文稿">
              {formError && (
                <p className="error" role="alert">
                  {formError}
                </p>
              )}
              <div className="readiness" data-ready={canGenerate || justQueued}>
                <Icon name={canGenerate || justQueued ? "check" : "warning"} />
                <p id="next-step" role="status">
                  {desktop ? nextStep : "桌面应用提供完整的视频处理能力。"}
                </p>
              </div>
              <button
                type="button"
                className="primary generate"
                disabled={!canGenerate}
                aria-describedby="next-step"
                onClick={() => void generate()}
              >
                <span>{queueing ? "正在准备…" : "生成文稿"}</span>
                <Icon name="arrow" />
              </button>
            </section>
            <TaskList queue={queue} />
          </div>
        </div>
      </main>
    </>
  );
}
