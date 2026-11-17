import { useId, useRef, useState, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import {
  errorMessage,
  message,
  redactMessage,
  renderMessage,
  type Message,
} from "./i18n";
import {
  OPENROUTER_ASR_MODEL,
  OPENROUTER_BASE_URL,
  listModels,
  validateModelConnection,
  type CatalogModel,
  type ModelConnection,
  type ModelPurpose,
} from "./models";

export interface ModelSettingsValue {
  asr: ModelConnection;
  llm: ModelConnection;
}

export const defaultModelSettings: ModelSettingsValue = {
  asr: {
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: "",
    model: OPENROUTER_ASR_MODEL,
  },
  llm: { baseUrl: OPENROUTER_BASE_URL, apiKey: "", model: "" },
};

interface CatalogLookup {
  baseUrl: string;
  apiKey: string;
  models?: CatalogModel[];
  error?: Message;
}

function ReasoningField({
  model,
  effort,
  onChange,
}: {
  model?: CatalogModel;
  effort: string;
  onChange: (effort: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [manual, setManual] = useState(false);
  const efforts = model?.reasoningEfforts ?? [];
  const useManualEffort =
    manual || (effort !== "" && !efforts.includes(effort));
  const defaultLabel = model?.defaultEffort
    ? t("model.namedDefaultEffort", { effort: model.defaultEffort })
    : t("model.defaultEffort");

  return (
    <details className="settings-advanced">
      <summary>
        <Icon name="down" />
        {t("model.effort")}
        <small className="advanced-selection" title={effort}>
          {effort || t("model.defaultEffort")}
        </small>
      </summary>
      <div className="advanced-content">
        {efforts.length > 0 && (
          <>
            <label htmlFor={id}>{t("model.effort")}</label>
            <select
              id={id}
              name="reasoning-effort-choice"
              value={useManualEffort ? "__manual__" : effort}
              onChange={(event) => {
                const value = event.target.value;
                setManual(value === "__manual__");
                if (value !== "__manual__") onChange(value);
              }}
            >
              <option value="">{defaultLabel}</option>
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
              <option value="__manual__">{t("model.manualEffort")}</option>
            </select>
          </>
        )}
        {(efforts.length === 0 || useManualEffort) && (
          <>
            <label htmlFor={id + "-custom"}>{t("model.customEffort")}</label>
            <input
              id={id + "-custom"}
              name="reasoning-effort"
              value={effort}
              placeholder={t("model.effortPlaceholder")}
              aria-describedby={efforts.length === 0 ? id + "-hint" : undefined}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
            />
            {efforts.length === 0 && (
              <p id={id + "-hint"} className="muted settings-hint">
                {t(model ? "model.noEfforts" : "model.detectEfforts")}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function ProviderFields({
  connection,
  setConnection,
  purpose,
}: {
  connection: ModelConnection;
  setConnection: (connection: ModelConnection) => void;
  purpose: ModelPurpose;
}) {
  const { t } = useTranslation();
  const id = useId();
  const request = useRef(0);
  const [lookup, setLookup] = useState<CatalogLookup>();
  const [manualModel, setManualModel] = useState(false);
  const catalog =
    lookup?.baseUrl === connection.baseUrl &&
    lookup.apiKey === connection.apiKey
      ? lookup
      : undefined;
  const models = catalog?.models ?? [];
  const selected = models.find((model) => model.id === connection.model.trim());
  const useManualModel = manualModel || !selected;
  const loading = Boolean(catalog && !catalog.error && !catalog.models);

  function editEndpoint(
    changes: Partial<Pick<ModelConnection, "baseUrl" | "apiKey">>,
  ) {
    request.current++;
    setLookup(undefined);
    setConnection({ ...connection, ...changes, reasoningEffort: undefined });
  }

  function editModel(model: string) {
    setConnection({
      ...connection,
      model,
      reasoningEffort:
        model.trim() === connection.model.trim()
          ? connection.reasoningEffort
          : undefined,
    });
  }

  async function fetchModels() {
    const serial = ++request.current;
    const endpoint = { baseUrl: connection.baseUrl, apiKey: connection.apiKey };
    setLookup({ ...endpoint });
    try {
      const models = await listModels(endpoint, purpose);
      if (serial === request.current) {
        setManualModel(false);
        setLookup({ ...endpoint, models });
      }
    } catch (error) {
      if (serial === request.current) {
        setLookup({
          ...endpoint,
          error: redactMessage(errorMessage(error), [endpoint.apiKey]),
        });
      }
    }
  }

  return (
    <fieldset className="settings-fields">
      <legend>{t(`model.purpose.${purpose}`)}</legend>
      <label htmlFor={id + "-url"}>{t("model.baseUrl")}</label>
      <input
        id={id + "-url"}
        name={id + "-url"}
        type="url"
        value={connection.baseUrl}
        required
        spellCheck={false}
        onChange={(event) => editEndpoint({ baseUrl: event.target.value })}
      />
      <label htmlFor={id + "-key"}>{t("model.apiKey")}</label>
      <input
        id={id + "-key"}
        name={id + "-key"}
        type="password"
        autoComplete="off"
        value={connection.apiKey}
        required
        onChange={(event) => editEndpoint({ apiKey: event.target.value })}
      />
      {models.length > 0 && (
        <>
          <label htmlFor={id + "-catalog"}>{t("model.select")}</label>
          <select
            id={id + "-catalog"}
            name={id + "-catalog"}
            value={!useManualModel && selected ? selected.id : ""}
            onChange={(event) => {
              const model = event.target.value;
              setManualModel(!model);
              if (model) editModel(model);
            }}
          >
            <option value="">{t("model.manualId")}</option>
            {models.map(({ id, name }) => (
              <option key={id} value={id}>
                {name === id ? id : `${name} · ${id}`}
              </option>
            ))}
          </select>
        </>
      )}
      {useManualModel && (
        <>
          <label htmlFor={id + "-model"}>{t("model.id")}</label>
          <input
            id={id + "-model"}
            name={id + "-model"}
            value={connection.model}
            required
            placeholder={t("model.idPlaceholder")}
            spellCheck={false}
            onChange={(event) => editModel(event.target.value)}
          />
        </>
      )}
      <div className="settings-catalog">
        <button
          type="button"
          className="quiet"
          disabled={loading}
          onClick={fetchModels}
        >
          {t(loading ? "model.fetching" : "model.fetch")}
        </button>
        <p className={catalog?.error ? "error" : "muted"} role="status">
          {catalog?.error
            ? renderMessage(t, catalog.error)
            : catalog?.models &&
              (models.length
                ? t("model.found", { count: models.length })
                : t("model.noModels"))}
        </p>
      </div>
      {purpose === "llm" && connection.model.trim() && (
        <ReasoningField
          key={connection.model.trim()}
          model={selected}
          effort={connection.reasoningEffort ?? ""}
          onChange={(reasoningEffort) =>
            setConnection({ ...connection, reasoningEffort })
          }
        />
      )}
    </fieldset>
  );
}

export function ModelSettings({
  value,
  configured,
  onSave,
}: {
  value: ModelSettingsValue;
  configured: boolean;
  onSave: (value: ModelSettingsValue) => void;
}) {
  const { t } = useTranslation();
  const modal = useRef<HTMLDialogElement>(null);
  const firstField = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<Message>();

  function openSettings() {
    setDraft(value);
    setError(undefined);
    modal.current?.showModal();
    firstField.current?.querySelector("input")?.focus();
  }

  function saveSettings(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    for (const purpose of ["asr", "llm"] as const) {
      try {
        validateModelConnection(draft[purpose]);
      } catch (error) {
        setError(
          message("error.modelSetting", {
            purpose: message(`model.purpose.${purpose}`),
            cause: errorMessage(error),
          }),
        );
        return;
      }
    }

    onSave(draft);
    modal.current?.close();
  }

  return (
    <>
      <button
        type="button"
        className="settings-trigger"
        data-configured={configured}
        aria-label={
          configured
            ? t("model.configuredLabel", {
                llm: value.llm.model,
                asr: value.asr.model,
              })
            : t("model.requireBoth")
        }
        title={
          configured
            ? t("model.configuredTitle", {
                llm: value.llm.model,
                asr: value.asr.model,
              })
            : t("model.requireBoth")
        }
        onClick={openSettings}
      >
        <Icon name="settings" />
        <span className="settings-trigger-copy">
          <strong>{configured ? value.llm.model : t("model.configure")}</strong>
          <small>
            {configured
              ? t("model.configuredSummary", { asr: value.asr.model })
              : t("model.notConfigured")}
          </small>
        </span>
        <Icon name={configured ? "check" : "warning"} />
      </button>
      <dialog
        ref={modal}
        className="settings-dialog"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
      >
        <form
          className="settings-form"
          noValidate
          onSubmit={saveSettings}
          onChange={() => setError(undefined)}
        >
          <header className="settings-header">
            <div>
              <h2 id="settings-title">{t("model.title")}</h2>
              <p id="settings-description" className="muted">
                {t("model.settingsDescription")}
              </p>
            </div>
            <button
              type="button"
              className="quiet icon-button"
              aria-label={t("model.close")}
              onClick={() => modal.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="settings-body" ref={firstField}>
            <ProviderFields
              connection={draft.asr}
              setConnection={(asr) =>
                setDraft((current) => ({ ...current, asr }))
              }
              purpose="asr"
            />
            <ProviderFields
              connection={draft.llm}
              setConnection={(llm) =>
                setDraft((current) => ({ ...current, llm }))
              }
              purpose="llm"
            />
          </div>
          <div className="settings-footer">
            {error && (
              <p className="error" role="alert">
                {renderMessage(t, error)}
              </p>
            )}
            <div className="actions settings-actions">
              <button type="button" onClick={() => modal.current?.close()}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="primary">
                {t("model.save")}
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}
