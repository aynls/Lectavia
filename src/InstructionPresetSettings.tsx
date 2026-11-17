import { useLayoutEffect, useRef, useState, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { errorMessage, message, renderMessage, type Message } from "./i18n";
import type { InstructionPreset } from "./instruction-presets";
import type { PromptFile } from "./tasks";

type PickPromptFile = () => Promise<PromptFile | null>;

type PresetView =
  | { kind: "list"; focusId?: string }
  | { kind: "edit"; preset?: InstructionPreset }
  | { kind: "delete"; preset: InstructionPreset };

function focusButton(button: HTMLButtonElement | null) {
  button?.focus();
}

function PresetEditor({
  preset,
  presets,
  onSave,
  onCancel,
  onPickFile,
}: {
  preset?: InstructionPreset;
  presets: InstructionPreset[];
  onSave: (preset: InstructionPreset) => void;
  onCancel: () => void;
  onPickFile?: PickPromptFile;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(preset?.name ?? "");
  const [content, setContent] = useState(
    preset?.prompt?.content ?? preset?.instructions ?? "",
  );
  const [fileName, setFileName] = useState(preset?.prompt?.name ?? "");
  const [importing, setImporting] = useState(false);
  const [nameError, setNameError] = useState<Message>();
  const [contentError, setContentError] = useState<Message>();
  const [error, setError] = useState<Message>();
  const nameInput = useRef<HTMLInputElement>(null);
  const contentInput = useRef<HTMLTextAreaElement>(null);

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importing) return;
    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    let invalidName: Message | undefined;
    if (!trimmedName) {
      invalidName = message("preset.nameRequired");
    } else if (
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
      if (!name.trim()) {
        setName(file.name);
        setNameError(undefined);
      }
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
          <label htmlFor="preset-name">{t("preset.name")}</label>
          <input
            ref={nameInput}
            id="preset-name"
            value={name}
            autoFocus
            required
            disabled={importing}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "preset-name-error" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
          />
          {nameError && (
            <p
              id="preset-name-error"
              className="error field-error"
              role="alert"
            >
              {renderMessage(t, nameError)}
            </p>
          )}
        </div>
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
            aria-describedby={contentError ? "preset-content-error" : undefined}
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
  presets,
  onChange,
  onPickFile,
}: {
  presets: InstructionPreset[];
  onChange: (presets: InstructionPreset[]) => void;
  onPickFile?: PickPromptFile;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<PresetView>({ kind: "list" });
  const [deleteError, setDeleteError] = useState(false);

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
    showList(preset.id);
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
        className="settings-dialog preset-dialog"
        aria-labelledby="preset-title"
        aria-describedby={
          view.kind === "delete" ? "preset-delete-description" : undefined
        }
        onClose={() => showList()}
      >
        <div className="settings-form">
          <header className="settings-header">
            <h2 id="preset-title">
              {t(
                view.kind === "edit"
                  ? view.preset
                    ? "preset.editTitle"
                    : "preset.create"
                  : view.kind === "delete"
                    ? "preset.deleteTitle"
                    : "output.presets",
              )}
            </h2>
            <button
              type="button"
              className="quiet icon-button"
              aria-label={t("preset.close")}
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          {view.kind === "list" && (
            <>
              <div className="settings-body preset-body">
                {presets.length > 0 ? (
                  <ul className="preset-list">
                    {presets.map((preset) => (
                      <li key={preset.id} className="preset-row">
                        <div className="preset-row-copy">
                          <h3>{preset.name}</h3>
                          <p className="muted">
                            {preset.prompt?.content ?? preset.instructions}
                          </p>
                        </div>
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
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t("preset.empty")}</p>
                )}
              </div>
              <footer className="settings-footer">
                <div className="actions settings-actions">
                  <button
                    type="button"
                    ref={createButton}
                    className="primary"
                    onClick={() => setView({ kind: "edit" })}
                  >
                    <Icon name="plus" />
                    {t("preset.create")}
                  </button>
                </div>
              </footer>
            </>
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
