import { useId, useRef, useState, type SubmitEvent } from "react";
import { Icon } from "./Icon";
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
  error?: string;
}

const purposeLabels: Record<ModelPurpose, string> = {
  asr: "语音转写",
  llm: "文稿整理",
};

function ReasoningField({
  model,
  effort,
  onChange,
}: {
  model?: CatalogModel;
  effort: string;
  onChange: (effort: string) => void;
}) {
  const id = useId();
  const [manual, setManual] = useState(false);
  const efforts = model?.reasoningEfforts ?? [];
  const useManualEffort =
    manual || (effort !== "" && !efforts.includes(effort));
  const defaultLabel = model?.defaultEffort
    ? `供应商默认（${model.defaultEffort}）`
    : "供应商默认";

  return (
    <details className="settings-advanced">
      <summary>
        <Icon name="down" />
        思考强度
        <small className="advanced-selection" title={effort}>
          {effort || "供应商默认"}
        </small>
      </summary>
      <div className="advanced-content">
        {efforts.length > 0 && (
          <>
            <label htmlFor={id}>思考强度</label>
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
              <option value="__manual__">手动填写</option>
            </select>
          </>
        )}
        {(efforts.length === 0 || useManualEffort) && (
          <>
            <label htmlFor={id + "-custom"}>自定义思考强度</label>
            <input
              id={id + "-custom"}
              name="reasoning-effort"
              value={effort}
              placeholder="留空时由供应商决定"
              aria-describedby={efforts.length === 0 ? id + "-hint" : undefined}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
            />
            {efforts.length === 0 && (
              <p id={id + "-hint"} className="muted settings-hint">
                {model
                  ? "供应商未列出此模型的档位。"
                  : "获取模型列表后可自动检测支持的档位。"}
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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return (
    <fieldset className="settings-fields">
      <legend>{purposeLabels[purpose]}</legend>
      <label htmlFor={id + "-url"}>API 基础地址</label>
      <input
        id={id + "-url"}
        name={id + "-url"}
        type="url"
        value={connection.baseUrl}
        required
        spellCheck={false}
        onChange={(event) => editEndpoint({ baseUrl: event.target.value })}
      />
      <label htmlFor={id + "-key"}>API Key</label>
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
          <label htmlFor={id + "-catalog"}>从列表选择模型</label>
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
            <option value="">手动填写模型 ID</option>
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
          <label htmlFor={id + "-model"}>模型 ID</label>
          <input
            id={id + "-model"}
            name={id + "-model"}
            value={connection.model}
            required
            placeholder="输入供应商提供的模型 ID"
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
          {loading ? "正在获取…" : "获取模型列表"}
        </button>
        <p className={catalog?.error ? "error" : "muted"} role="status">
          {catalog?.error ??
            (catalog?.models &&
              (models.length
                ? `找到 ${models.length} 个模型`
                : "供应商未返回模型，可以手动填写。"))}
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
  const modal = useRef<HTMLDialogElement>(null);
  const firstField = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");

  function openSettings() {
    setDraft(value);
    setError("");
    modal.current?.showModal();
    firstField.current?.querySelector("input")?.focus();
  }

  function saveSettings(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    for (const purpose of ["asr", "llm"] as const) {
      try {
        validateModelConnection(draft[purpose]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(`${purposeLabels[purpose]}：${message}`);
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
            ? `模型设置。整理模型 ${value.llm.model}，转写模型 ${value.asr.model}`
            : "配置模型，尚未配置转写与整理服务"
        }
        title={
          configured
            ? `整理：${value.llm.model}\n转写：${value.asr.model}`
            : "生成前需要配置转写与整理模型"
        }
        onClick={openSettings}
      >
        <Icon name="settings" />
        <span className="settings-trigger-copy">
          <strong>{configured ? value.llm.model : "配置模型"}</strong>
          <small>
            {configured
              ? `整理模型 · 转写 ${value.asr.model}`
              : "尚未配置，生成前需要完成"}
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
          onSubmit={saveSettings}
          onChange={() => setError("")}
        >
          <header className="settings-header">
            <div>
              <h2 id="settings-title">模型设置</h2>
              <p id="settings-description" className="muted">
                分别配置语音转写和文稿整理服务。API Key 仅在本次运行期间保留。
              </p>
            </div>
            <button
              type="button"
              className="quiet icon-button"
              aria-label="关闭模型设置"
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
                {error}
              </p>
            )}
            <div className="actions settings-actions">
              <button type="button" onClick={() => modal.current?.close()}>
                取消
              </button>
              <button type="submit" className="primary">
                保存设置
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}
