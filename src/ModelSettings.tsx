import { useId, useRef, useState, type SubmitEvent } from "react";
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
    setConnection({ ...connection, ...changes });
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
      <legend>{purpose === "asr" ? "语音转写" : "资料整理"}</legend>
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
      <div className="settings-catalog">
        <button type="button" disabled={loading} onClick={fetchModels}>
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
              if (model) setConnection({ ...connection, model });
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
            spellCheck={false}
            onChange={(event) =>
              setConnection({ ...connection, model: event.target.value })
            }
          />
        </>
      )}
    </fieldset>
  );
}

export function ModelSettings({
  value,
  onSave,
}: {
  value: ModelSettingsValue;
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

    try {
      const { asr, llm } = draft;
      validateModelConnection(asr);
      validateModelConnection(llm);
      onSave(draft);
      modal.current?.close();
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    }
  }

  return (
    <>
      <button type="button" className="settings-trigger" onClick={openSettings}>
        模型设置
      </button>
      <dialog
        ref={modal}
        className="settings-dialog"
        aria-labelledby="settings-title"
      >
        <h2 id="settings-title">模型设置</h2>
        <p className="muted">
          分别配置两项 OpenAI 兼容服务。密钥仅保存在本次应用运行期间。
        </p>
        <form aria-labelledby="settings-title" onSubmit={saveSettings}>
          <div className="settings-group" ref={firstField}>
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
        </form>
      </dialog>
    </>
  );
}
