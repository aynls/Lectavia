import {
  useId,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type SubmitEvent,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import {
  errorMessage,
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
  type ModelConnectionErrors,
  type ModelConnectionField,
  type ModelPurpose,
} from "./models";

export interface ModelSettingsValue {
  asr: ModelConnection;
  llm: ModelConnection;
}

interface ModelSettingsOpenOptions {
  purpose?: ModelPurpose;
  saveAndRetry?: boolean;
  onSaved?: (value: ModelSettingsValue) => void;
}

export interface ModelSettingsHandle {
  open: (options?: ModelSettingsOpenOptions) => void;
}

interface ModelSettingsFocus {
  purpose: ModelPurpose;
  field: ModelConnectionField;
}

type SettingsErrors = Record<ModelPurpose, ModelConnectionErrors>;

const connectionFields = ["baseUrl", "apiKey", "model"] as const;
const modelPurposes = ["asr", "llm"] as const;

function firstInvalidField(errors: ModelConnectionErrors) {
  return connectionFields.find((field) => errors[field]);
}

function validateSettings(value: ModelSettingsValue): SettingsErrors {
  return {
    asr: validateModelConnection(value.asr),
    llm: validateModelConnection(value.llm),
  };
}

function firstInvalidSetting(
  errors: SettingsErrors,
): ModelSettingsFocus | undefined {
  for (const purpose of modelPurposes) {
    const field = firstInvalidField(errors[purpose]);
    if (field) return { purpose, field };
  }
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
  efforts,
  defaultEffort,
  effort,
  onChange,
}: {
  efforts: string[];
  defaultEffort?: string;
  effort: string;
  onChange: (effort: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const selectedEffort = efforts.includes(effort) ? effort : "";
  const defaultLabel = defaultEffort
    ? t("model.namedDefaultEffort", { effort: defaultEffort })
    : t("model.defaultEffort");

  return (
    <details className="settings-advanced">
      <summary>
        <Icon name="down" />
        {t("model.effort")}
        <small className="advanced-selection" title={selectedEffort}>
          {selectedEffort || t("model.defaultEffort")}
        </small>
      </summary>
      <div className="advanced-content">
        <label htmlFor={id}>{t("model.effort")}</label>
        <select
          id={id}
          value={selectedEffort}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{defaultLabel}</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        {efforts.length === 0 && (
          <p className="muted settings-hint">{t("model.noEfforts")}</p>
        )}
      </div>
    </details>
  );
}

function ProviderFields({
  connection,
  errors,
  setConnection,
  onLoadingChange,
  purpose,
}: {
  connection: ModelConnection;
  errors?: ModelConnectionErrors;
  setConnection: (
    connection: ModelConnection,
    changedField?: ModelConnectionField,
  ) => void;
  onLoadingChange: (purpose: ModelPurpose, loading: boolean) => void;
  purpose: ModelPurpose;
}) {
  const { t } = useTranslation();
  const id = useId();
  const request = useRef(0);
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const [lookup, setLookup] = useState<CatalogLookup>();
  const [manualModel, setManualModel] = useState(false);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const catalog =
    lookup?.baseUrl === connection.baseUrl &&
    lookup.apiKey === connection.apiKey
      ? lookup
      : undefined;
  const models = catalog?.models ?? [];
  const selected = models.find((model) => model.id === connection.model.trim());
  const useManualModel = manualModel || !selected;
  const loading = Boolean(catalog && !catalog.error && !catalog.models);

  function editEndpoint(field: "baseUrl" | "apiKey", value: string) {
    const providerChanged =
      field === "baseUrl" &&
      value.trim().replace(/\/+$/, "") !==
        connection.baseUrl.trim().replace(/\/+$/, "");
    request.current++;
    onLoadingChange(purpose, false);
    setLookup(undefined);
    setConnection(
      {
        ...connection,
        [field]: value,
        reasoningEffort: providerChanged
          ? undefined
          : connection.reasoningEffort,
        reasoningEfforts: providerChanged
          ? undefined
          : connection.reasoningEfforts,
        defaultEffort: providerChanged ? undefined : connection.defaultEffort,
      },
      field,
    );
  }

  function editModel(model: string) {
    const sameModel = model.trim() === connection.model.trim();
    const metadata = models.find((entry) => entry.id === model.trim());
    setConnection(
      {
        ...connection,
        model,
        reasoningEffort: sameModel ? connection.reasoningEffort : undefined,
        reasoningEfforts: sameModel
          ? connection.reasoningEfforts
          : metadata?.reasoningEfforts,
        defaultEffort: sameModel
          ? connection.defaultEffort
          : metadata?.defaultEffort,
      },
      "model",
    );
  }

  async function fetchModels() {
    const serial = ++request.current;
    const endpoint = { baseUrl: connection.baseUrl, apiKey: connection.apiKey };
    setLookup({ ...endpoint });
    onLoadingChange(purpose, true);
    try {
      const models = await listModels(endpoint, purpose);
      if (serial === request.current) {
        setManualModel(false);
        setLookup({ ...endpoint, models });
        const current = currentConnection.current;
        const model = models.find((entry) => entry.id === current.model.trim());
        const efforts = model?.reasoningEfforts ?? [];
        setConnection({
          ...current,
          reasoningEfforts: model?.reasoningEfforts,
          defaultEffort: model?.defaultEffort,
          reasoningEffort: efforts.includes(current.reasoningEffort ?? "")
            ? current.reasoningEffort
            : undefined,
        });
      }
    } catch (error) {
      if (serial === request.current) {
        const current = currentConnection.current;
        setConnection({
          ...current,
          reasoningEffort: undefined,
          reasoningEfforts: undefined,
          defaultEffort: undefined,
        });
        setLookup({
          ...endpoint,
          error: redactMessage(errorMessage(error), [endpoint.apiKey]),
        });
      }
    } finally {
      if (serial === request.current) onLoadingChange(purpose, false);
    }
  }

  function inputState(field: ModelConnectionField) {
    return {
      "data-model-field": field,
      "aria-invalid": Boolean(errors?.[field]),
      "aria-describedby": errors?.[field] ? `${id}-${field}-error` : undefined,
    };
  }

  function renderFieldError(field: ModelConnectionField) {
    const error = errors?.[field];
    return error ? (
      <p id={`${id}-${field}-error`} className="error field-error">
        {renderMessage(t, error)}
      </p>
    ) : null;
  }

  return (
    <fieldset className="settings-fields" data-model-purpose={purpose}>
      <legend>{t(`model.purpose.${purpose}`)}</legend>
      <label htmlFor={id + "-url"}>{t("model.baseUrl")}</label>
      <input
        id={id + "-url"}
        name={id + "-url"}
        type="url"
        value={connection.baseUrl}
        required
        spellCheck={false}
        {...inputState("baseUrl")}
        onChange={(event) => editEndpoint("baseUrl", event.target.value)}
      />
      {renderFieldError("baseUrl")}
      <label htmlFor={id + "-key"}>{t("model.apiKey")}</label>
      <input
        id={id + "-key"}
        name={id + "-key"}
        type="password"
        autoComplete="off"
        value={connection.apiKey}
        required
        {...inputState("apiKey")}
        onChange={(event) => editEndpoint("apiKey", event.target.value)}
      />
      {renderFieldError("apiKey")}
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
            {...inputState("model")}
            onChange={(event) => editModel(event.target.value)}
          />
          {renderFieldError("model")}
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
          efforts={connection.reasoningEfforts ?? []}
          defaultEffort={connection.defaultEffort}
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
  ref,
  value,
  onSave,
}: {
  ref?: Ref<ModelSettingsHandle>;
  value: ModelSettingsValue;
  onSave: (value: ModelSettingsValue) => Promise<void>;
}) {
  const { t } = useTranslation();
  const modal = useRef<HTMLDialogElement>(null);
  const savedCallback = useRef<ModelSettingsOpenOptions["onSaved"]>(undefined);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<Message>();
  const [validation, setValidation] = useState<SettingsErrors>();
  const [focus, setFocus] = useState<ModelSettingsFocus>();
  const [saving, setSaving] = useState(false);
  const [saveAndRetry, setSaveAndRetry] = useState(false);
  const [session, setSession] = useState(0);
  const [loadingModels, setLoadingModels] = useState<
    Record<ModelPurpose, boolean>
  >({
    asr: false,
    llm: false,
  });

  useLayoutEffect(() => {
    if (!focus || !modal.current?.open) return;
    const { purpose, field } = focus;
    modal.current
      .querySelector<HTMLInputElement>(
        `[data-model-purpose="${purpose}"] [data-model-field="${field}"]`,
      )
      ?.focus();
  }, [focus]);

  function openSettings(options: ModelSettingsOpenOptions = {}) {
    const dialog = modal.current;
    if (!dialog || dialog.open) return;

    const errors = validateSettings(value);
    setSession((current) => current + 1);
    setLoadingModels({ asr: false, llm: false });
    setSaveAndRetry(Boolean(options.saveAndRetry));
    setDraft(value);
    setError(undefined);
    setValidation(undefined);
    setFocus(
      options.purpose
        ? {
            purpose: options.purpose,
            field: firstInvalidField(errors[options.purpose]) ?? "baseUrl",
          }
        : (firstInvalidSetting(errors) ?? { purpose: "asr", field: "baseUrl" }),
    );
    savedCallback.current = options.onSaved;
    dialog.showModal();
  }

  useImperativeHandle(ref, () => ({ open: openSettings }));

  function updateDraft(
    purpose: ModelPurpose,
    connection: ModelConnection,
    changedField?: ModelConnectionField,
  ) {
    setDraft((current) => ({ ...current, [purpose]: connection }));
    if (changedField) {
      setValidation(
        (current) =>
          current && {
            ...current,
            [purpose]: { ...current[purpose], [changedField]: undefined },
          },
      );
    }
  }

  async function saveSettings(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loadingModels.asr || loadingModels.llm) return;

    const errors = validateSettings(draft);
    const invalidField = firstInvalidSetting(errors);
    if (invalidField) {
      setError(undefined);
      setValidation(errors);
      setFocus(invalidField);
      return;
    }

    const next = {
      ...draft,
      llm: {
        ...draft.llm,
        reasoningEffort: draft.llm.reasoningEfforts?.includes(
          draft.llm.reasoningEffort ?? "",
        )
          ? draft.llm.reasoningEffort
          : undefined,
      },
    };
    setSaving(true);
    try {
      await onSave(next);
    } catch (error) {
      setError(
        redactMessage(errorMessage(error, "error.saveModelSettings"), [
          draft.asr.apiKey,
          draft.llm.apiKey,
        ]),
      );
      return;
    } finally {
      setSaving(false);
    }
    const onSaved = savedCallback.current;
    savedCallback.current = undefined;
    modal.current?.close();
    onSaved?.(next);
  }

  return (
    <dialog
      ref={modal}
      className="settings-dialog"
      aria-labelledby="settings-title"
      aria-describedby="settings-description"
      onCancel={(event) => {
        if (saving) event.preventDefault();
      }}
      onClose={(event) => {
        if (!event.currentTarget.open) savedCallback.current = undefined;
      }}
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
              {t(isTauri() ? "model.savedKey" : "model.sessionKey")}
            </p>
          </div>
          <button
            type="button"
            className="quiet icon-button"
            aria-label={t("model.close")}
            disabled={saving}
            onClick={() => modal.current?.close()}
          >
            <Icon name="close" />
          </button>
        </header>
        <fieldset className="settings-body" disabled={saving}>
          {modelPurposes.map((purpose) => (
            <ProviderFields
              key={`${purpose}-${session}`}
              connection={draft[purpose]}
              errors={validation?.[purpose]}
              setConnection={(connection, changedField) =>
                updateDraft(purpose, connection, changedField)
              }
              onLoadingChange={(modelPurpose, loading) =>
                setLoadingModels((current) => ({
                  ...current,
                  [modelPurpose]: loading,
                }))
              }
              purpose={purpose}
            />
          ))}
        </fieldset>
        <div className="settings-footer">
          {error && (
            <p className="error" role="alert">
              {renderMessage(t, error)}
            </p>
          )}
          <div className="actions settings-actions">
            <button
              type="button"
              disabled={saving}
              onClick={() => modal.current?.close()}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={saving || loadingModels.asr || loadingModels.llm}
            >
              {t(
                saving
                  ? "model.saving"
                  : saveAndRetry
                    ? "model.saveAndRetry"
                    : "model.save",
              )}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
