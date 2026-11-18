import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { errorMessage, renderMessage, type Message } from "./i18n";

interface McpStatus {
  port: number;
  endpoint: string;
  autoStart: boolean;
  running: boolean;
  startError: Message | null;
  stdioEnabled: boolean;
  stdioRunning: boolean;
  stdioError: Message | null;
}

type Transport = "http" | "stdio";

type McpUpdate =
  | { type: "setRunning"; running: boolean }
  | { type: "setStdio"; enabled: boolean }
  | { type: "setPort"; port: number }
  | { type: "setAutoStart"; enabled: boolean };

function TransportRow({
  transport,
  running,
  enabled,
  pending,
  disabled,
  onChange,
  action,
}: {
  transport: Transport;
  running: boolean;
  enabled: boolean;
  pending: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const statusId = `mcp-${transport}-status`;
  const state = pending
    ? enabled
      ? "mcp.settings.stopping"
      : "mcp.settings.starting"
    : running
      ? "mcp.settings.running"
      : "mcp.settings.stopped";

  return (
    <div className="settings-mcp-transport">
      <div className="settings-mcp-heading">
        <h4 id={`mcp-${transport}-title`}>
          <label htmlFor={`mcp-${transport}-toggle`}>
            {transport === "http" ? "HTTP" : "stdio"}
          </label>
        </h4>
        <span
          id={statusId}
          className="settings-mcp-status"
          data-running={running}
          role="status"
        >
          {t(state)}
        </span>
      </div>
      <div className="settings-mcp-actions">
        {action}
        <input
          id={`mcp-${transport}-toggle`}
          className="settings-mcp-switch"
          type="checkbox"
          role="switch"
          aria-describedby={statusId}
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </div>
    </div>
  );
}

export function McpSettings() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const portInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<McpStatus>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<Message>();
  const [pending, setPending] = useState<McpUpdate["type"] | "copy">();
  const [error, setError] = useState<{
    transport: Transport;
    message: Message;
  }>();
  const [copied, setCopied] = useState<Transport>();
  const [portDraft, setPortDraft] = useState<string>();
  const [validatePort, setValidatePort] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    invoke<McpStatus>("get_mcp_status")
      .then((next) => {
        if (current) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (current)
          setLoadError(errorMessage(cause, "mcp.settings.loadFailed"));
      });
    return () => {
      current = false;
    };
  }, [desktop, loadAttempt]);

  const running = status?.running ?? false;
  const portValue = portDraft ?? String(status?.port ?? "");
  const port = Number(portValue);
  const portIsValid =
    /^[0-9]{1,5}$/.test(portValue) && port >= 1 && port <= 65535;
  const invalidPort = validatePort && !portIsValid;
  const portIsDirty = status !== undefined && portValue !== String(status.port);
  const busy = pending !== undefined;
  const httpError =
    error?.transport === "http" ? error.message : status?.startError;
  const stdioError =
    error?.transport === "stdio" ? error.message : status?.stdioError;

  async function update(change: McpUpdate) {
    setPending(change.type);
    setError(undefined);
    setCopied(undefined);
    try {
      setStatus(await invoke<McpStatus>("update_mcp", { update: change }));
      if (change.type === "setPort") {
        setPortDraft(undefined);
        setValidatePort(false);
      }
    } catch (cause) {
      setError({
        transport: change.type === "setStdio" ? "stdio" : "http",
        message: errorMessage(cause, "mcp.settings.saveFailed"),
      });
    } finally {
      setPending(undefined);
    }
  }

  function savePort(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || running || busy || !portIsDirty) return;
    if (!portIsValid) {
      setValidatePort(true);
      portInput.current?.focus();
      return;
    }
    void update({ type: "setPort", port });
  }

  async function copyConfig(transport: Transport) {
    setPending("copy");
    setError(undefined);
    setCopied(undefined);
    try {
      await invoke("copy_mcp_config", { transport });
      setCopied(transport);
    } catch (cause) {
      setError({
        transport,
        message: errorMessage(cause, "mcp.settings.copyFailed"),
      });
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section
      className="settings-panel settings-section settings-mcp-panel"
      aria-labelledby="mcp-title"
    >
      <header className="settings-header settings-mcp-header">
        <h3 id="mcp-title">{t("mcp.settings.title")}</h3>
      </header>
      {status ? (
        <>
          <section
            className="settings-body settings-mcp-body"
            aria-labelledby="mcp-http-title"
          >
            <TransportRow
              transport="http"
              running={running}
              enabled={running}
              pending={pending === "setRunning"}
              disabled={busy || portIsDirty}
              onChange={(running) =>
                void update({ type: "setRunning", running })
              }
            />
            <div className="settings-mcp-fields">
              <div className="settings-mcp-field">
                <label htmlFor="mcp-endpoint">
                  {t("mcp.settings.endpoint")}
                </label>
                <div className="settings-mcp-controls">
                  <input
                    id="mcp-endpoint"
                    dir="ltr"
                    value={status.endpoint}
                    readOnly
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t("mcp.settings.copyHttp")}
                    onClick={() => void copyConfig("http")}
                  >
                    <Icon name={copied === "http" ? "check" : "copy"} />
                    {t("mcp.settings.copy")}
                  </button>
                </div>
              </div>
              <form className="settings-mcp-field" onSubmit={savePort}>
                <label htmlFor="mcp-port">{t("mcp.settings.port")}</label>
                <div className="settings-mcp-controls">
                  <input
                    ref={portInput}
                    id="mcp-port"
                    inputMode="numeric"
                    value={portValue}
                    disabled={busy || running}
                    aria-invalid={invalidPort || undefined}
                    aria-describedby={
                      invalidPort ? "mcp-port-feedback" : undefined
                    }
                    onBlur={() => setValidatePort(true)}
                    onChange={(event) => {
                      setPortDraft(event.target.value);
                      setError(undefined);
                      setCopied(undefined);
                    }}
                  />
                  <button
                    type="submit"
                    disabled={busy || running || !portIsDirty}
                  >
                    {t("settings.save")}
                  </button>
                </div>
                {invalidPort && (
                  <p id="mcp-port-feedback" className="error settings-mcp-note">
                    {t("mcp.settings.invalidPort")}
                  </p>
                )}
              </form>
            </div>
            {httpError && (
              <p role="alert" className="error settings-mcp-note">
                {renderMessage(t, httpError)}
              </p>
            )}
            <div className="settings-mcp-autostart">
              <label htmlFor="mcp-autostart">
                {t("mcp.settings.autoStart")}
              </label>
              <input
                id="mcp-autostart"
                className="settings-mcp-switch"
                type="checkbox"
                role="switch"
                checked={status.autoStart}
                disabled={busy}
                onChange={(event) =>
                  void update({
                    type: "setAutoStart",
                    enabled: event.target.checked,
                  })
                }
              />
            </div>
          </section>
          <section
            className="settings-body settings-mcp-body settings-mcp-stdio"
            aria-labelledby="mcp-stdio-title"
          >
            <TransportRow
              transport="stdio"
              running={status.stdioRunning}
              enabled={status.stdioEnabled}
              pending={pending === "setStdio"}
              disabled={busy}
              onChange={(enabled) => void update({ type: "setStdio", enabled })}
              action={
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("mcp.settings.copyStdio")}
                  onClick={() => void copyConfig("stdio")}
                >
                  <Icon name={copied === "stdio" ? "check" : "copy"} />
                  {t("mcp.settings.copy")}
                </button>
              }
            />
            {stdioError && (
              <p role="alert" className="error settings-mcp-note">
                {renderMessage(t, stdioError)}
              </p>
            )}
          </section>
        </>
      ) : (
        <div className="settings-row">
          {loadError ? (
            <>
              <p role="alert" className="error">
                {renderMessage(t, loadError)}
              </p>
              <button
                type="button"
                onClick={() => {
                  setLoadError(undefined);
                  setLoadAttempt((attempt) => attempt + 1);
                }}
              >
                {t("mcp.settings.retry")}
              </button>
            </>
          ) : (
            <p role="status" className="muted settings-mcp-note">
              {t(
                desktop
                  ? "mcp.settings.loading"
                  : "mcp.settings.desktopRequired",
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
