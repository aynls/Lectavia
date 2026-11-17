import { useRef, useState, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import {
  changeLocale,
  currentLocale,
  isLocale,
  languages,
  type MessageKey,
} from "./i18n";

function focusHeading(heading: HTMLHeadingElement | null) {
  heading?.focus({ preventScroll: true });
}

export function SettingsPage({
  modelsConfigured,
  initialMaxConcurrency,
  onSaveMaxConcurrency,
  onOpenModels,
  onOpenPresets,
}: {
  modelsConfigured: boolean;
  initialMaxConcurrency: number | null;
  onSaveMaxConcurrency: (limit: number | null) => void;
  onOpenModels: () => void;
  onOpenPresets: () => void;
}) {
  const { t } = useTranslation();
  const maxConcurrencyInput = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<MessageKey>();
  const invalidConcurrency = feedback === "settings.invalidConcurrency";

  function saveConcurrency(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = maxConcurrencyInput.current;
    if (!input) return;
    if (!input.validity.valid) {
      setFeedback("settings.invalidConcurrency");
      input.focus();
      return;
    }

    const limit = input.value === "" ? null : input.valueAsNumber;
    try {
      onSaveMaxConcurrency(limit);
      input.value = limit === null ? "" : String(limit);
      setFeedback("settings.savedConcurrency");
    } catch {
      setFeedback("settings.saveConcurrencyFailed");
    }
  }

  return (
    <main className="app-width app-main settings-page">
      <div className="settings-page-content">
        <h2 tabIndex={-1} ref={focusHeading}>
          {t("settings.title")}
        </h2>
        <div className="settings-panel">
          <div className="settings-row">
            <label htmlFor="settings-language">{t("common.language")}</label>
            <select
              id="settings-language"
              name="language"
              value={currentLocale()}
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
          </div>
          <form
            className="settings-row"
            aria-labelledby="max-concurrency-label"
            noValidate
            onSubmit={saveConcurrency}
          >
            <div className="settings-row-copy">
              <label htmlFor="max-concurrency" id="max-concurrency-label">
                {t("settings.maxConcurrency")}
              </label>
              <p id="max-concurrency-hint" className="muted">
                {t("settings.concurrencyHint")}
              </p>
            </div>
            <div className="settings-concurrency-controls">
              <input
                id="max-concurrency"
                name="max-concurrency"
                ref={maxConcurrencyInput}
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                defaultValue={initialMaxConcurrency ?? ""}
                placeholder={t("settings.unlimitedConcurrency")}
                aria-invalid={invalidConcurrency || undefined}
                aria-describedby={
                  invalidConcurrency
                    ? "max-concurrency-hint max-concurrency-feedback"
                    : "max-concurrency-hint"
                }
                onChange={() => setFeedback(undefined)}
              />
              <button type="submit">{t("settings.save")}</button>
            </div>
            {feedback && (
              <p
                id="max-concurrency-feedback"
                className={
                  feedback === "settings.savedConcurrency" ? "muted" : "error"
                }
                role={
                  feedback === "settings.savedConcurrency" ? "status" : "alert"
                }
              >
                {t(feedback)}
              </p>
            )}
          </form>
          <button
            type="button"
            className="quiet settings-row"
            aria-haspopup="dialog"
            onClick={onOpenModels}
          >
            <span className="settings-row-copy">
              <strong>{t("model.title")}</strong>
              <span className="muted">
                {t(
                  modelsConfigured ? "model.configured" : "model.notConfigured",
                )}
              </span>
            </span>
            <Icon name="arrow" />
          </button>
          <button
            type="button"
            className="quiet settings-row"
            aria-haspopup="dialog"
            onClick={onOpenPresets}
          >
            <strong>{t("output.presets")}</strong>
            <Icon name="arrow" />
          </button>
        </div>
      </div>
    </main>
  );
}
