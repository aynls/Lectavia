import { useId, useRef, useState, type SubmitEvent } from "react";
import {
  OPENROUTER_ASR_MODEL,
  OPENROUTER_BASE_URL,
  validateModelConnection,
  type ModelConnection,
} from "./models";

export interface ModelSettingsValue {
  asr: ModelConnection;
  llm: ModelConnection;
  shared: boolean;
}

export const defaultModelSettings: ModelSettingsValue = {
  asr: {
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: "",
    model: OPENROUTER_ASR_MODEL,
  },
  llm: { baseUrl: OPENROUTER_BASE_URL, apiKey: "", model: "" },
  shared: true,
};

export function getModelConnections(settings: ModelSettingsValue) {
  const { asr, llm, shared } = settings;
  return { asr, llm: shared ? { ...asr, model: llm.model } : llm };
}

function ProviderFields({
  connection,
  setConnection,
  group,
  shared,
}: {
  connection: ModelConnection;
  setConnection: (connection: ModelConnection) => void;
  group: string;
  shared?: boolean;
}) {
  const id = useId();

  return (
    <fieldset className="settings-fields">
      <legend>{group}</legend>
      {!shared && (
        <>
          <label htmlFor={id + "-url"}>API 基础地址</label>
          <input
            id={id + "-url"}
            type="url"
            value={connection.baseUrl}
            required
            spellCheck={false}
            onChange={(event) =>
              setConnection({ ...connection, baseUrl: event.target.value })
            }
          />
          <label htmlFor={id + "-key"}>API Key</label>
          <input
            id={id + "-key"}
            type="password"
            autoComplete="off"
            value={connection.apiKey}
            required
            onChange={(event) =>
              setConnection({ ...connection, apiKey: event.target.value })
            }
          />
        </>
      )}
      <label htmlFor={id + "-model"}>模型 ID</label>
      <input
        id={id + "-model"}
        value={connection.model}
        required
        spellCheck={false}
        onChange={(event) =>
          setConnection({ ...connection, model: event.target.value })
        }
      />
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
      const { asr, llm } = getModelConnections(draft);
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
          密钥仅保存在本次应用运行期间。转写默认使用 OpenRouter。
        </p>
        <form onSubmit={saveSettings}>
          <div className="settings-group" ref={firstField}>
            <ProviderFields
              connection={draft.asr}
              setConnection={(asr) => setDraft({ ...draft, asr })}
              group="语音转写"
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.shared}
                onChange={(event) =>
                  setDraft({ ...draft, shared: event.target.checked })
                }
              />
              整理模型复用转写服务的地址和密钥
            </label>
            <ProviderFields
              connection={draft.llm}
              setConnection={(llm) => setDraft({ ...draft, llm })}
              group="资料整理"
              shared={draft.shared}
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
