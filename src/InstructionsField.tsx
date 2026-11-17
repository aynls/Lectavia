import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { renderMessage, type Message } from "./i18n";
import type { InstructionPreset } from "./instruction-presets";
import type { PromptFile } from "./tasks";
import "./InstructionsField.css";

interface InstructionsFieldProps {
  presets: readonly InstructionPreset[];
  presetId: string;
  instructions: string;
  prompt: PromptFile | null;
  error?: Message;
  canSavePreset: boolean;
  canImport: boolean;
  onSelectPreset: (id: string) => void;
  onChange: (text: string) => void;
  onSavePreset: (focusEditor: () => void) => void;
  onImport: () => void;
  onRemovePrompt: () => void;
}

export function InstructionsField({
  presets,
  presetId,
  instructions,
  prompt,
  error,
  canSavePreset,
  canImport,
  onSelectPreset,
  onChange,
  onSavePreset,
  onImport,
  onRemovePrompt,
}: InstructionsFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const preset = presets.find((entry) => entry.id === presetId);
  const summary =
    preset?.name ??
    prompt?.name ??
    t(
      instructions.trim()
        ? "output.customInstructions"
        : "output.defaultInstructions",
    );
  const hint = prompt
    ? t("output.importedInstructions")
    : preset && t("output.perTaskInstructions");

  return (
    <div className="instructions-field">
      <details className="settings-advanced instructions-disclosure">
        <summary>
          <Icon name="down" />
          <span>{t("output.instructions")}</span>
          <small className="advanced-selection">{summary}</small>
        </summary>
        <div className="instructions-editor">
          {presets.length > 0 && (
            <div className="option">
              <label htmlFor={id + "-preset"}>{t("output.presets")}</label>
              <select
                name="instruction-preset"
                id={id + "-preset"}
                value={presetId}
                onChange={(event) => onSelectPreset(event.target.value)}
              >
                <option value="">{t("output.choosePreset")}</option>
                {presets.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {prompt && (
            <div className="prompt-file">
              <Icon name="document" />
              <span>{prompt.name}</span>
              <button
                type="button"
                className="quiet icon-button"
                aria-label={t("common.removeFile", { name: prompt.name })}
                onClick={() => {
                  onRemovePrompt();
                  editor.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          <div className="option">
            <label htmlFor={id + "-content"}>{t("output.instructions")}</label>
            {hint && (
              <p id={id + "-hint"} className="muted instructions-hint">
                {hint}
              </p>
            )}
            <textarea
              ref={editor}
              id={id + "-content"}
              name="custom-instructions"
              rows={4}
              aria-describedby={hint ? id + "-hint" : undefined}
              value={prompt?.content ?? instructions}
              placeholder={t("output.placeholder")}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
          <div className="prompt-import">
            <button
              type="button"
              className="quiet import-prompt"
              onClick={onImport}
              disabled={!canImport}
            >
              <Icon name="upload" />
              {t(prompt ? "output.replace" : "output.import")}
            </button>
            <button
              type="button"
              className="quiet import-prompt"
              disabled={!canSavePreset}
              onClick={() => onSavePreset(() => editor.current?.focus())}
            >
              <Icon name="save" />
              {t("output.savePreset")}
            </button>
          </div>
        </div>
      </details>
      {error && (
        <p className="error field-error" role="alert">
          {renderMessage(t, error)}
        </p>
      )}
    </div>
  );
}
