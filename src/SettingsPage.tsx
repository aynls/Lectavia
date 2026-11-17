import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { changeLocale, currentLocale, isLocale, languages } from "./i18n";

function focusHeading(heading: HTMLHeadingElement | null) {
  heading?.focus({ preventScroll: true });
}

export function SettingsPage({
  modelsConfigured,
  onOpenModels,
  onOpenPresets,
}: {
  modelsConfigured: boolean;
  onOpenModels: () => void;
  onOpenPresets: () => void;
}) {
  const { t } = useTranslation();

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
