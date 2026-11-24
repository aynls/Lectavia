import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
  OPENROUTER_ASR_URL,
  OPENROUTER_LLM_URL,
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

interface ModelSettingsFocus {
  purpose: ModelPurpose;
  field: ModelConnectionField;
}

type SettingsErrors = Record<ModelPurpose, ModelConnectionErrors>;

const connectionFields = ["baseUrl", "apiKey", "catalogUrl", "model"] as const;
const modelPurposes = ["asr", "llm"] as const;

function firstInvalidField(errors: ModelConnectionErrors) {
  return connectionFields.find((field) => errors[field]);
}

function needsOrganizationModel(value: ModelSettingsValue, required: boolean) {
  return required || Boolean(value.llm.apiKey.trim() || value.llm.model.trim());
}

function validateSettings(
  value: ModelSettingsValue,
  requireOrganization: boolean,
): SettingsErrors {
  return {
    asr: validateModelConnection(value.asr),
    llm: needsOrganizationModel(value, requireOrganization)
      ? validateModelConnection(value.llm)
      : {},
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

const defaultModelSettings: ModelSettingsValue = {
  asr: {
    baseUrl: OPENROUTER_ASR_URL,
    apiKey: "",
    model: OPENROUTER_ASR_MODEL,
  },
  llm: { baseUrl: OPENROUTER_LLM_URL, apiKey: "", model: "" },
};

interface CatalogLookup {
  catalogUrl: string;
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

  return (
    <div className="settings-model-field settings-model-effort">
      <label htmlFor={id}>{t("model.effort")}</label>
      <select
        id={id}
        name={id}
        disabled={efforts.length === 0}
        aria-describedby={efforts.length === 0 ? `${id}-hint` : undefined}
        value={selectedEffort}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {defaultEffort
            ? t("model.namedDefaultEffort", { effort: defaultEffort })
            : t("model.defaultEffort")}
        </option>
        {efforts.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      {efforts.length === 0 && (
        <p id={`${id}-hint`} className="muted settings-model-note">
          {t("model.noEfforts")}
        </p>
      )}
    </div>
  );
}

function ProviderFields({
  connection,
  errors,
  setConnection,
  onLoadingChange,
  purpose,
  required,
}: {
  connection: ModelConnection;
  errors?: ModelConnectionErrors;
  setConnection: (
    connection: ModelConnection,
    changedField?: ModelConnectionField,
  ) => void;
  onLoadingChange: (purpose: ModelPurpose, loading: boolean) => void;
  purpose: ModelPurpose;
  required: boolean;
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
  const catalogUrl = connection.catalogUrl ?? "";
  const catalog =
    lookup?.catalogUrl === catalogUrl && lookup.apiKey === connection.apiKey
      ? lookup
      : undefined;
  const models = catalog?.models ?? [];
  const modelId = connection.model.trim();
  const showCatalog = models.length > 0 && !manualModel;
  const selectedModel = showCatalog
    ? models.find((model) => model.id === modelId)
    : undefined;
  const hasModelName = selectedModel && selectedModel.name !== modelId;
  const loading = Boolean(catalog && !catalog.error && !catalog.models);
  const catalogAction = t(
    loading
      ? "model.fetching"
      : manualModel && models.length
        ? "model.select"
        : "model.fetch",
  );

  function editEndpoint(
    field: "baseUrl" | "apiKey" | "catalogUrl",
    value: string,
  ) {
    const providerChanged =
      field !== "apiKey" && value.trim() !== (connection[field] ?? "").trim();
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
    const endpoint = { catalogUrl, apiKey: connection.apiKey };
    setLookup({ ...endpoint });
    onLoadingChange(purpose, true);
    try {
      const models = await listModels(catalogUrl, endpoint.apiKey, purpose);
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
    <div
      className="settings-model-group"
      role="group"
      aria-labelledby={id + "-purpose"}
      data-model-purpose={purpose}
    >
      <h4 id={id + "-purpose"}>{t(`model.purpose.${purpose}`)}</h4>
      <div className="settings-model-endpoint">
        <div className="settings-model-field">
          <label htmlFor={id + "-url"}>{t("model.baseUrl")}</label>
          <input
            id={id + "-url"}
            name={id + "-url"}
            type="url"
            value={connection.baseUrl}
            required={required}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            {...inputState("baseUrl")}
            onChange={(event) => editEndpoint("baseUrl", event.target.value)}
          />
          {renderFieldError("baseUrl")}
        </div>
        <div className="settings-model-field">
          <label htmlFor={id + "-key"}>{t("model.apiKey")}</label>
          <input
            id={id + "-key"}
            name={id + "-key"}
            type="password"
            autoComplete="off"
            value={connection.apiKey}
            required={required}
            {...inputState("apiKey")}
            onChange={(event) => editEndpoint("apiKey", event.target.value)}
          />
          {renderFieldError("apiKey")}
        </div>
        <div className="settings-model-field">
          <label htmlFor={id + "-catalog-url"}>{t("model.catalogUrl")}</label>
          <input
            id={id + "-catalog-url"}
            name={id + "-catalog-url"}
            type="url"
            value={catalogUrl}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            {...inputState("catalogUrl")}
            onChange={(event) => editEndpoint("catalogUrl", event.target.value)}
          />
          {renderFieldError("catalogUrl")}
        </div>
      </div>
      <div className="settings-model-choices">
        <div className="settings-model-field">
          <label htmlFor={id + "-model"}>
            {t(showCatalog ? "model.label" : "model.id")}
          </label>
          <div className="settings-model-picker">
            {showCatalog ? (
              <select
                className="settings-model-select"
                id={id + "-model"}
                name={id + "-model"}
                required={required}
                value={modelId ? `model:${modelId}` : ""}
                {...inputState("model")}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "manual") {
                    setManualModel(true);
                  } else {
                    editModel(value.slice("model:".length));
                  }
                }}
              >
                <button type="button">
                  {selectedModel?.name ?? (modelId || t("model.select"))}
                </button>
                <option value="" disabled>
                  {t("model.select")}
                </option>
                {modelId && !selectedModel && (
                  <option value={`model:${modelId}`}>{modelId}</option>
                )}
                {models.map(({ id, name }) => (
                  <option key={id} value={`model:${id}`}>
                    <span>
                      {name}
                      {name !== id && (
                        <>
                          {" "}
                          <span className="settings-model-option-id">{id}</span>
                        </>
                      )}
                    </span>
                  </option>
                ))}
                <option value="manual">{t("model.manualId")}</option>
              </select>
            ) : (
              <input
                id={id + "-model"}
                name={id + "-model"}
                value={connection.model}
                autoFocus={manualModel && models.length > 0}
                required={required}
                placeholder={t("model.idPlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                {...inputState("model")}
                onChange={(event) => editModel(event.target.value)}
              />
            )}
            <button
              type="button"
              className="settings-model-list"
              disabled={loading || !catalogUrl.trim()}
              onClick={() => {
                if (manualModel && models.length) {
                  setManualModel(false);
                } else {
                  void fetchModels();
                }
              }}
            >
              <Icon name="list" />
              {catalogAction}
            </button>
          </div>
          {renderFieldError("model")}
          <div className="settings-model-meta">
            {hasModelName && (
              <p className="muted settings-model-note">{modelId}</p>
            )}
            <p
              className={`settings-model-note ${catalog?.error ? "error" : "muted"}`}
              role="status"
            >
              {catalog?.error
                ? renderMessage(t, catalog.error)
                : catalog?.models &&
                  (models.length
                    ? t("model.found", { count: models.length })
                    : t("model.noModels"))}
            </p>
          </div>
        </div>
        {purpose === "llm" && (
          <ReasoningField
            efforts={connection.reasoningEfforts ?? []}
            defaultEffort={connection.defaultEffort}
            effort={connection.reasoningEffort ?? ""}
            onChange={(reasoningEffort) =>
              setConnection({ ...connection, reasoningEffort })
            }
          />
        )}
      </div>
    </div>
  );
}

export function ModelSettings({
  value,
  saving,
  focusOnOpen,
  purpose,
  retryAfterSave,
  onSave,
  onSaved,
  onCancel,
}: {
  value: ModelSettingsValue | null;
  saving: boolean;
  focusOnOpen: boolean;
  purpose?: ModelPurpose;
  retryAfterSave: boolean;
  onSave: (value: ModelSettingsValue) => Promise<void>;
  onSaved?: (value: ModelSettingsValue) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const form = useRef<HTMLFormElement>(null);
  const savedValue = value ?? defaultModelSettings;
  const [draft, setDraft] = useState(savedValue);
  const [error, setError] = useState<Message>();
  const [validation, setValidation] = useState<SettingsErrors>();
  const requireOrganization = retryAfterSave || purpose === "llm";
  const [focus, setFocus] = useState<ModelSettingsFocus | undefined>(() => {
    if (!focusOnOpen) return;
    const errors = validateSettings(savedValue, requireOrganization);
    if (purpose) {
      return {
        purpose,
        field: firstInvalidField(errors[purpose]) ?? "baseUrl",
      };
    }
    return firstInvalidSetting(errors) ?? { purpose: "asr", field: "baseUrl" };
  });
  const [session, setSession] = useState(0);
  const [loadingModels, setLoadingModels] = useState<
    Record<ModelPurpose, boolean>
  >({
    asr: false,
    llm: false,
  });
  const loading = loadingModels.asr || loadingModels.llm;

  useLayoutEffect(() => {
    if (!focus) return;
    const { purpose, field } = focus;
    form.current
      ?.querySelector<HTMLElement>(
        `[data-model-purpose="${purpose}"] [data-model-field="${field}"]`,
      )
      ?.focus();
  }, [focus]);

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

  function cancelEditing() {
    if (onCancel) {
      onCancel();
      return;
    }
    setDraft(savedValue);
    setValidation(undefined);
    setError(undefined);
    setSession((current) => current + 1);
    setLoadingModels({ asr: false, llm: false });
  }

  async function saveSettings(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading) return;

    const errors = validateSettings(draft, requireOrganization);
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
    setError(undefined);
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
    }

    setDraft(next);
    setValidation(undefined);
    onSaved?.(next);
  }

  return (
    <section
      className="settings-panel settings-section"
      aria-labelledby="model-settings-title"
    >
      <form
        ref={form}
        aria-labelledby="model-settings-title"
        method="post"
        noValidate
        onSubmit={saveSettings}
        onChange={() => setError(undefined)}
      >
        <header className="settings-header">
          <div>
            <h3 id="model-settings-title">{t("model.title")}</h3>
            <p className="muted">
              {t(isTauri() ? "model.savedKey" : "model.sessionKey")}
            </p>
          </div>
        </header>
        <fieldset
          className="settings-body settings-model-body"
          disabled={saving}
        >
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
              required={
                purpose === "asr" ||
                needsOrganizationModel(draft, requireOrganization)
              }
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
            <p className="muted settings-status" role="status">
              {draft === savedValue &&
                t(value ? "model.configured" : "model.notConfigured")}
            </p>
            <button type="button" disabled={saving} onClick={cancelEditing}>
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={saving || loading}
            >
              {t(
                saving
                  ? "model.saving"
                  : retryAfterSave
                    ? "model.saveAndRetry"
                    : "model.save",
              )}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
