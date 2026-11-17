import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type SubmitEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { errorMessage, message, renderMessage, type Message } from "./i18n";
import type { InstructionPreset } from "./instruction-presets";
import type { PromptFile } from "./tasks";

type PickPromptFile = () => Promise<PromptFile | null>;
type PresetDraft = Pick<InstructionPreset, "instructions" | "prompt">;

export interface InstructionPresetSettingsHandle {
  saveDraft: (draft: PresetDraft, onSaved: (id: string) => void) => void;
}

type PresetView =
  | { kind: "list"; focusId?: string }
  | { kind: "edit"; preset?: InstructionPreset }
  | { kind: "save"; draft: PresetDraft; onSaved: (id: string) => void }
  | { kind: "delete"; preset: InstructionPreset };

const maxNameLength = 30;
const nameSegmenter = new Intl.Segmenter();

function focusButton(button: HTMLButtonElement | null) {
  button?.focus();
}

function PresetEditor({
  preset,
  draft,
  presets,
  onSave,
  onCancel,
  onPickFile,
}: {
  preset?: InstructionPreset;
  draft?: PresetDraft;
  presets: InstructionPreset[];
  onSave: (preset: InstructionPreset) => void;
  onCancel: () => void;
  onPickFile?: PickPromptFile;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(preset?.name ?? "");
  const initialContent = draft ?? preset;
  const [content, setContent] = useState(
    initialContent?.prompt?.content ?? initialContent?.instructions ?? "",
  );
  const [fileName, setFileName] = useState(initialContent?.prompt?.name ?? "");
  const [importing, setImporting] = useState(false);
  const [nameError, setNameError] = useState<Message>();
  const [contentError, setContentError] = useState<Message>();
  const [error, setError] = useState<Message>();
  const nameInput = useRef<HTMLInputElement>(null);
  const contentInput = useRef<HTMLTextAreaElement>(null);
  const trimmedName = name.trim();
  const nameLength = Array.from(nameSegmenter.segment(trimmedName)).length;
  const nameLimitError =
    nameLength > maxNameLength && trimmedName !== preset?.name
      ? message("preset.nameTooLong", { limit: maxNameLength })
      : undefined;
  const displayedNameError = nameLimitError ?? nameError;
  const showNameLength = nameLength <= maxNameLength || nameLimitError;

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importing) return;
    const trimmedContent = content.trim();
    let invalidName = nameLimitError;
    if (!trimmedName) {
      invalidName = message("preset.nameRequired");
    } else if (
      !invalidName &&
      presets.some(
        (entry) => entry.id !== preset?.id && entry.name === trimmedName,
      )
    ) {
      invalidName = message("preset.nameTaken");
    }
    setNameError(invalidName);
    setContentError(
      trimmedContent ? undefined : message("preset.contentRequired"),
    );
    setError(undefined);

    if (invalidName || !trimmedContent) {
      (invalidName ? nameInput : contentInput).current?.focus();
      return;
    }

    try {
      onSave({
        id: preset?.id ?? crypto.randomUUID(),
        name: trimmedName,
        instructions: fileName ? "" : trimmedContent,
        prompt: fileName ? { name: fileName, content } : null,
      });
    } catch {
      setError(message("error.saveInstructionPreset"));
    }
  }

  async function importFile() {
    if (!onPickFile || importing) return;
    setImporting(true);
    setError(undefined);
    try {
      const file = await onPickFile();
      if (!file) return;
      setContent(file.content);
      setContentError(undefined);
      setFileName(file.name);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <form
        id="preset-editor"
        className="settings-body preset-body preset-editor"
        noValidate
        onSubmit={save}
      >
        <div>
          <div className="preset-name-heading">
            <label htmlFor="preset-name">{t("preset.name")}</label>
            {showNameLength && (
              <span className="muted" id="preset-name-length">
                {nameLength} / {maxNameLength}
              </span>
            )}
          </div>
          <input
            ref={nameInput}
            id="preset-name"
            value={name}
            autoFocus
            required
            disabled={importing}
            aria-invalid={displayedNameError ? true : undefined}
            aria-describedby={
              displayedNameError
                ? "preset-name-error"
                : showNameLength
                  ? "preset-name-length"
                  : undefined
            }
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
          />
          {displayedNameError && (
            <p
              id="preset-name-error"
              className="error field-error"
              role="alert"
            >
              {renderMessage(t, displayedNameError)}
            </p>
          )}
        </div>
        {!draft && (
          <div>
            <label htmlFor="preset-content">{t("output.instructions")}</label>
            <textarea
              ref={contentInput}
              id="preset-content"
              rows={7}
              value={content}
              required
              disabled={importing}
              aria-invalid={contentError ? true : undefined}
              aria-describedby={
                contentError ? "preset-content-error" : undefined
              }
              onChange={(event) => {
                setContent(event.target.value);
                setContentError(undefined);
              }}
            />
            {contentError && (
              <p
                id="preset-content-error"
                className="error field-error"
                role="alert"
              >
                {renderMessage(t, contentError)}
              </p>
            )}
            {(fileName || onPickFile) && (
              <div className="preset-import">
                {fileName && (
                  <span className="muted" title={fileName}>
                    {fileName}
                  </span>
                )}
                {onPickFile && (
                  <button
                    type="button"
                    className="quiet import-prompt"
                    disabled={importing}
                    onClick={() => void importFile()}
                  >
                    <Icon name="upload" />
                    {t(fileName ? "output.replace" : "output.import")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </form>
      <footer className="settings-footer">
        {error && (
          <p className="error" role="alert">
            {renderMessage(t, error)}
          </p>
        )}
        <div className="actions settings-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            form="preset-editor"
            disabled={importing}
          >
            {t("preset.save")}
          </button>
        </div>
      </footer>
    </>
  );
}

export function InstructionPresetSettings({
  ref,
  presets,
  onChange,
  onPickFile,
}: {
  ref?: Ref<InstructionPresetSettingsHandle>;
  presets: InstructionPreset[];
  onChange: (presets: InstructionPreset[]) => void;
  onPickFile?: PickPromptFile;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<PresetView>({ kind: "list" });
  const [deleteError, setDeleteError] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      saveDraft(draft, onSaved) {
        dialog.current?.showModal();
        setView({ kind: "save", draft, onSaved });
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (view.kind === "list" && !view.focusId && dialog.current?.open) {
      createButton.current?.focus();
    }
  }, [view]);

  function showList(focusId?: string) {
    setView({ kind: "list", focusId });
    setDeleteError(false);
  }

  function savePreset(preset: InstructionPreset) {
    const next = presets.some((entry) => entry.id === preset.id)
      ? presets.map((entry) => (entry.id === preset.id ? preset : entry))
      : [...presets, preset];
    onChange(next);
    if (view.kind === "save") {
      dialog.current?.close();
      view.onSaved(preset.id);
    } else {
      showList(preset.id);
    }
  }

  function deletePreset(id: string) {
    try {
      onChange(presets.filter((entry) => entry.id !== id));
      showList();
    } catch {
      setDeleteError(true);
    }
  }

  return (
    <>
      <button
        type="button"
        className="settings-trigger preset-trigger"
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          createButton.current?.focus();
        }}
      >
        <Icon name="bookmark" />
        <span className="settings-trigger-copy">
          <strong>{t("output.presets")}</strong>
        </span>
      </button>
      <dialog
        ref={dialog}
        className={`settings-dialog preset-dialog${view.kind === "save" ? " preset-save-dialog" : ""}`}
        aria-labelledby="preset-title"
        aria-describedby={
          view.kind === "delete" ? "preset-delete-description" : undefined
        }
        onClose={() => showList()}
      >
        <div className="settings-form">
          <header className="settings-header preset-header">
            <h2 id="preset-title">
              {t(
                view.kind === "edit"
                  ? view.preset
                    ? "preset.editTitle"
                    : "preset.create"
                  : view.kind === "delete"
                    ? "preset.deleteTitle"
                    : view.kind === "save"
                      ? "output.savePreset"
                      : "output.presets",
              )}
            </h2>
            <div className="preset-header-actions">
              {view.kind === "list" && (
                <button
                  type="button"
                  ref={createButton}
                  className="primary preset-create-button"
                  onClick={() => setView({ kind: "edit" })}
                >
                  <Icon name="plus" />
                  {t("preset.create")}
                </button>
              )}
              <button
                type="button"
                className="quiet icon-button"
                aria-label={t("preset.close")}
                onClick={() => dialog.current?.close()}
              >
                <Icon name="close" />
              </button>
            </div>
          </header>
          {view.kind === "list" && (
            <div className="settings-body preset-body preset-list-body">
              {presets.length > 0 ? (
                <ul className="preset-list">
                  {presets.map((preset) => (
                    <li key={preset.id} className="preset-row">
                      <div className="preset-row-heading">
                        <h3>{preset.name}</h3>
                        <div className="actions preset-row-actions">
                          <button
                            type="button"
                            ref={
                              view.focusId === preset.id
                                ? focusButton
                                : undefined
                            }
                            aria-label={t("preset.editNamed", {
                              name: preset.name,
                            })}
                            onClick={() => setView({ kind: "edit", preset })}
                          >
                            {t("preset.edit")}
                          </button>
                          <button
                            type="button"
                            className="quiet preset-delete"
                            aria-label={t("preset.deleteNamed", {
                              name: preset.name,
                            })}
                            onClick={() => setView({ kind: "delete", preset })}
                          >
                            {t("preset.delete")}
                          </button>
                        </div>
                      </div>
                      <p className="muted preset-preview">
                        {preset.prompt?.content ?? preset.instructions}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted preset-empty">{t("preset.empty")}</p>
              )}
            </div>
          )}
          {view.kind === "edit" && (
            <PresetEditor
              preset={view.preset}
              presets={presets}
              onSave={savePreset}
              onCancel={() => showList(view.preset?.id)}
              onPickFile={onPickFile}
            />
          )}
          {view.kind === "save" && (
            <PresetEditor
              draft={view.draft}
              presets={presets}
              onSave={savePreset}
              onCancel={() => dialog.current?.close()}
            />
          )}
          {view.kind === "delete" && (
            <>
              <div className="settings-body preset-body">
                <p id="preset-delete-description">
                  {t("preset.deleteDescription", { name: view.preset.name })}
                </p>
              </div>
              <footer className="settings-footer">
                {deleteError && (
                  <p className="error" role="alert">
                    {t("error.deleteInstructionPreset")}
                  </p>
                )}
                <div className="actions settings-actions">
                  <button
                    type="button"
                    autoFocus
                    aria-describedby="preset-delete-description"
                    onClick={() => showList(view.preset.id)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="preset-delete"
                    onClick={() => deletePreset(view.preset.id)}
                  >
                    {t("preset.delete")}
                  </button>
                </div>
              </footer>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
