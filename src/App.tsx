import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type SubmitEvent,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  changeLocale,
  currentLocale,
  errorMessage,
  isLocale,
  languages,
  message,
  renderMessage,
  type Message,
} from "./i18n";
import { Icon } from "./Icon";
import { inspectMedia, partLabel, type MediaInfo } from "./media";
import {
  defaultModelSettings,
  ModelSettings,
  type ModelSettingsValue,
} from "./ModelSettings";
import { TaskList } from "./TaskList";
import { TaskQueue, type PromptFile, type TaskRequest } from "./tasks";
import { parseVideoLink, type VideoSource } from "./video-source";
import logoUrl from "../design/lectavia-logo.svg";
import "./App.css";

type SourceMode = "link" | "local";
type FolderStatus = "checking" | "ready" | "error";

const queue = new TaskQueue();
const desktop = isTauri();
const FOLDER_STORAGE_KEY = "lectavia.output-directory";

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
  const { t } = useTranslation();
  const locale = currentLocale();
  const [sourceMode, setSourceMode] = useState<SourceMode>("link");
  const [link, setLink] = useState("");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [selectedParts, setSelectedParts] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [sourceError, setSourceError] = useState<Message>();
  const [formError, setFormError] = useState<Message>();
  const [folder, setFolder] = useState("");
  const [folderStatus, setFolderStatus] = useState<FolderStatus>(
    desktop ? "checking" : "error",
  );
  const [folderError, setFolderError] = useState<Message>();
  const [format, setFormat] = useState<"md" | "txt">("md");
  const [instructions, setInstructions] = useState("");
  const [prompt, setPrompt] = useState<PromptFile | null>(null);
  const [settings, setSettings] = useState<ModelSettingsValue | null>(null);
  const [queueing, setQueueing] = useState(false);
  const composer = useRef<HTMLElement>(null);
  const restoreDialog = useRef<HTMLDialogElement>(null);
  const pendingRestoreId = useRef("");
  const workspaceRevision = useRef(0);
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
      t(
        sourceError
          ? sourceMode === "link"
            ? "workspace.need.checkLink"
            : "workspace.need.reselectFile"
          : sourceMode === "link" && link.trim()
            ? "workspace.need.parse"
            : "workspace.need.video",
      ),
    );
  } else if (selected.size === 0) {
    missing.push(t("workspace.need.parts"));
  }
  if (!settings) missing.push(t("workspace.need.models"));
  if (folderStatus === "error" || (!folder && folderStatus !== "checking")) {
    missing.push(t("workspace.need.folder"));
  }

  const nextStep =
    desktop && !previewing && !queueing && missing.length > 0
      ? t("workspace.next", {
          steps: new Intl.ListFormat(locale).format(missing),
        })
      : undefined;

  useEffect(() => {
    if (!desktop) return;

    let active = true;
    const revision = workspaceRevision.current;
    async function prepareFolder() {
      const previous = rememberedFolder();
      if (previous) {
        try {
          await invoke("validate_output_directory", { directory: previous });
          if (!active || revision !== workspaceRevision.current) return;
          setFolder(previous);
          setFolderStatus("ready");
          return;
        } catch {
          // An unavailable previous directory falls back to the default.
        }
      }

      try {
        const path = await invoke<string>("default_output_directory");
        if (!active || revision !== workspaceRevision.current) return;
        setFolder(path);
        setFolderStatus("ready");
        setFolderError(undefined);
        rememberFolder(path);
      } catch {
        if (!active || revision !== workspaceRevision.current) return;
        setFolderStatus("error");
        setFolderError(message("error.defaultFolder"));
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
    setSourceError(undefined);
  }

  async function preview(source: VideoSource) {
    const key = source.kind === "local" ? source.path : source.url;
    if (previewKey.current === key) return;

    clearPreview();
    setFormError(undefined);
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
      setSourceError(message("error.invalidVideoLink"));
      return;
    }
    void preview(source);
  }

  function changeLink(value: string) {
    setLink(value);
    clearPreview();
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
    setFormError(undefined);
  }

  async function chooseVideo() {
    const revision = workspaceRevision.current;
    try {
      const path = await open({
        title: t("media.fileDialog"),
        multiple: false,
        filters: [
          {
            name: t("media.fileFilter"),
            extensions: ["mp4", "mkv", "webm", "mov", "m4v", "avi"],
          },
        ],
      });

      if (path && revision === workspaceRevision.current) {
        setLink("");
        void preview({ kind: "local", path });
      }
    } catch {
      if (revision !== workspaceRevision.current) return;
      setSourceError(message("error.openVideoDialog"));
    }
  }

  async function chooseFolder() {
    const revision = workspaceRevision.current;
    setFormError(undefined);
    setFolderError(undefined);
    try {
      const path = await open({
        title: t("output.chooseDialog"),
        directory: true,
        multiple: false,
        defaultPath: folder || undefined,
      });
      if (!path || revision !== workspaceRevision.current) return;

      setFolderStatus("checking");
      try {
        await invoke("validate_output_directory", { directory: path });
        if (revision !== workspaceRevision.current) return;
        setFolder(path);
        setFolderStatus("ready");
        rememberFolder(path);
      } catch (error) {
        if (revision !== workspaceRevision.current) return;
        setFolderStatus(folder ? "ready" : "error");
        setFolderError(
          message("error.chooseAnotherFolder", { cause: errorMessage(error) }),
        );
      }
    } catch {
      if (revision !== workspaceRevision.current) return;
      setFolderStatus(folder ? "ready" : "error");
      setFolderError(message("error.openFolderDialog"));
    }
  }

  async function choosePrompt() {
    const revision = workspaceRevision.current;
    setFormError(undefined);
    try {
      const file = await invoke<PromptFile | null>("choose_prompt_file", {
        title: t("output.promptDialog"),
        filterName: t("common.markdownFilter"),
      });
      if (file && revision === workspaceRevision.current) setPrompt(file);
    } catch (error) {
      if (revision !== workspaceRevision.current) return;
      setFormError(errorMessage(error));
    }
  }

  function removeVideo() {
    setLink("");
    clearPreview();
    if (sourceMode === "link") linkInput.current?.focus();
  }

  function restoreRequest(request: TaskRequest) {
    workspaceRevision.current += 1;
    clearPreview();

    const source = request.media.parts[0].source;
    setSourceMode(source.kind === "local" ? "local" : "link");
    setLink(request.link);
    previewKey.current =
      source.kind === "local"
        ? source.path
        : (URL.parse(request.link.trim())?.href ?? "");
    setMedia(request.media);
    setSelectedParts(request.selectedParts);
    setInstructions(request.instructions);
    setPrompt(request.prompt);
    setFolder(request.outputDirectory);
    setFolderStatus("ready");
    setFolderError(undefined);
    setFormat(request.format);
    setSettings({ asr: request.asr, llm: request.llm });
    setFormError(undefined);
    composer.current?.focus();
  }

  function restoreTask(taskId: string) {
    if (link.trim() || media || instructions.trim() || prompt) {
      const dialog = restoreDialog.current;
      if (dialog) {
        pendingRestoreId.current = taskId;
        dialog.returnValue = "";
        dialog.showModal();
      }
      return;
    }

    const request = queue.getRequest(taskId);
    if (request) restoreRequest(request);
  }

  function finishRestore(dialog: HTMLDialogElement) {
    if (dialog.open) return;
    const taskId = pendingRestoreId.current;
    const confirmed = dialog.returnValue === "restore";
    pendingRestoreId.current = "";
    dialog.returnValue = "";

    if (confirmed) {
      const request = queue.getRequest(taskId);
      if (request) restoreRequest(request);
    }
  }

  async function generate() {
    if (!canGenerate || !media || !settings) return;

    const revision = workspaceRevision.current;
    setFormError(undefined);
    setFolderError(undefined);
    setQueueing(true);
    try {
      await invoke("validate_output_directory", { directory: folder });
      queue.enqueue({
        link,
        media,
        selectedParts,
        outputDirectory: folder,
        locale,
        format,
        instructions,
        prompt,
        ...settings,
      });
      if (revision === workspaceRevision.current) rememberFolder(folder);
    } catch (error) {
      if (revision !== workspaceRevision.current) return;
      setFolderStatus("error");
      setFolderError(message("error.unavailableFolder"));
      setFormError(message("error.generation", { cause: errorMessage(error) }));
    } finally {
      setQueueing(false);
    }
  }

  return (
    <>
      <header className="top-bar">
        <div className="app-width app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <img src={logoUrl} alt="" />
            </span>
            Lectavia
          </div>
          <div className="header-controls">
            <label className="language-picker">
              <span className="sr-only">{t("common.language")}</span>
              <select
                value={locale}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isLocale(value)) void changeLocale(value);
                }}
              >
                {Object.entries(languages).map(([code, name]) => (
                  <option key={code} value={code} lang={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <ModelSettings
              value={settings ?? defaultModelSettings}
              configured={settings !== null}
              onSave={(next) => {
                setSettings(next);
                setFormError(undefined);
              }}
            />
          </div>
        </div>
      </header>
      <main className="app-width">
        {!desktop && <p className="notice">{t("workspace.desktopRequired")}</p>}
        <div className="workspace-title">
          <h1 id="workspace-title" className="sr-only">
            {t("workspace.title")}
          </h1>
          <div className="workspace-art" aria-hidden="true">
            <div className="art-window">
              <div className="art-screen">
                <span />
                <span />
                <span />
              </div>
              <div className="art-captions">
                <span />
                <span />
              </div>
            </div>
            <div className="signal-script">
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
        </div>
        <div className="workspace">
          <section
            ref={composer}
            tabIndex={-1}
            className="composer"
            aria-labelledby="workspace-title"
          >
            <section className="source-section" aria-labelledby="input-heading">
              <div className="section-heading">
                <h2 id="input-heading">{t("media.choose")}</h2>
                <p>{t("media.intro")}</p>
              </div>
              <div
                className="source-tabs"
                role="tablist"
                aria-label={t("media.source")}
              >
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
                  {t("media.linkTab")}
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
                  {t("media.localTab")}
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
                      {t("media.linkLabel")}
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
                          placeholder={t("media.linkPlaceholder")}
                          value={link}
                          disabled={!desktop}
                          aria-invalid={Boolean(link && sourceError)}
                          aria-describedby={
                            link && sourceError ? "source-error" : undefined
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
                        {t(previewing ? "media.inspecting" : "media.inspect")}
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
                        {t(
                          localMedia
                            ? "media.reselectFile"
                            : "media.chooseFile",
                        )}
                      </strong>
                      <small>{t("media.formats")}</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                )}
              </div>
              {previewing && (
                <div
                  className="media media-loading media-heading enter"
                  role="status"
                >
                  <span className="media-fallback" aria-hidden="true" />
                  <div className="media-title">
                    <p className="muted">{t("media.loading")}</p>
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
                  {renderMessage(t, sourceError)}
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
                        {t("media.readyToGenerate")}
                      </p>
                      <h3>{media.title}</h3>
                      <p className="muted">
                        {media.uploader ??
                          (localMedia
                            ? t("media.local")
                            : t("media.partsCount", {
                                count: media.parts.length,
                              }))}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="quiet icon-button"
                      aria-label={t("media.remove")}
                      title={t("media.remove")}
                      onClick={removeVideo}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                  {media.multipart && (
                    <fieldset className="parts">
                      <legend>{t("media.selectParts")}</legend>
                      <div className="parts-heading">
                        <p className="muted" role="status">
                          {t("media.selected", {
                            selected: selected.size,
                            total: media.parts.length,
                          })}
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
                          {t(
                            selected.size === media.parts.length
                              ? "media.deselectAll"
                              : "media.selectAll",
                          )}
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
                            {partLabel(part, t)}
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
                <h2 id="output-heading">{t("output.settings")}</h2>
                <p>{t("output.intro")}</p>
              </div>
              <div className="options">
                <div className="option">
                  <span className="option-label">{t("output.location")}</span>
                  <button
                    type="button"
                    className="directory-choice"
                    aria-label={
                      folder
                        ? t("output.changeLocation", { folder })
                        : t("output.chooseLocation")
                    }
                    title={folder || undefined}
                    onClick={chooseFolder}
                    disabled={!desktop}
                  >
                    <Icon name="folder" />
                    <span>
                      {folder ||
                        (folderStatus === "checking"
                          ? t("output.preparingFolder")
                          : t("output.chooseFolder"))}
                    </span>
                    <Icon name="down" />
                  </button>
                  {folderError && (
                    <p className="error field-error" role="alert">
                      {renderMessage(t, folderError)}
                    </p>
                  )}
                </div>
                <div className="option">
                  <label htmlFor="output-format">{t("output.format")}</label>
                  <select
                    id="output-format"
                    value={format}
                    onChange={(event) =>
                      setFormat(event.target.value === "txt" ? "txt" : "md")
                    }
                  >
                    <option value="md">{t("common.markdown")}</option>
                    <option value="txt">{t("common.plainText")}</option>
                  </select>
                </div>
              </div>
              <div className="instructions-field">
                <div className="field-label-row">
                  <label htmlFor="custom-instructions">
                    {t("output.instructions")}
                  </label>
                  <span>{t("output.optional")}</span>
                </div>
                <textarea
                  id="custom-instructions"
                  rows={4}
                  value={instructions}
                  placeholder={t("output.placeholder")}
                  onChange={(event) => setInstructions(event.target.value)}
                />
                <div className="prompt-import">
                  <button
                    type="button"
                    className="quiet import-prompt"
                    onClick={choosePrompt}
                    disabled={!desktop}
                  >
                    <Icon name="upload" />
                    {t(prompt ? "output.replace" : "output.import")}
                  </button>
                  {prompt && (
                    <div className="prompt-file">
                      <Icon name="document" />
                      <span title={prompt.name}>{prompt.name}</span>
                      <button
                        type="button"
                        className="quiet icon-button"
                        aria-label={t("common.removeFile", {
                          name: prompt.name,
                        })}
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
            <section className="action-panel" aria-label={t("output.generate")}>
              {formError && (
                <p className="error" role="alert">
                  {renderMessage(t, formError)}
                </p>
              )}
              {nextStep && (
                <div className="readiness">
                  <Icon name="warning" />
                  <p id="next-step" role="status">
                    {nextStep}
                  </p>
                </div>
              )}
              <button
                type="button"
                className="primary generate"
                disabled={!canGenerate}
                aria-describedby={nextStep ? "next-step" : undefined}
                onClick={() => void generate()}
              >
                <span>
                  {t(queueing ? "output.queueing" : "output.generate")}
                </span>
                <Icon name="arrow" />
              </button>
            </section>
            <TaskList queue={queue} onRestore={restoreTask} />
          </div>
        </div>
      </main>
      <dialog
        ref={restoreDialog}
        className="settings-dialog restore-dialog"
        aria-labelledby="restore-title"
        aria-describedby="restore-description"
        onClose={(event) => finishRestore(event.currentTarget)}
      >
        <form method="dialog" className="settings-form">
          <header className="settings-header">
            <div>
              <h2 id="restore-title">{t("restore.title")}</h2>
              <p id="restore-description" className="muted">
                {t("restore.description")}
              </p>
            </div>
          </header>
          <div className="settings-footer">
            <div className="actions settings-actions">
              <button type="submit" value="cancel" autoFocus>
                {t("common.cancel")}
              </button>
              <button type="submit" value="restore" className="primary">
                {t("restore.confirm")}
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}
