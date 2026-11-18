import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { StackSimpleIcon } from "@phosphor-icons/react/dist/csr/StackSimple";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { errorMessage, renderMessage, type Message } from "./i18n";
import { partLabel } from "./media";
import {
  isUnfinished,
  revealOutput,
  type Task,
  type TaskPart,
  type TaskQueue,
  type TaskRecovery,
} from "./tasks";
import "./TaskList.css";

const documentPhases = [
  "audio",
  "transcription",
  "organization",
  "output",
] as const;
const transcriptPhases = ["audio", "transcription", "output"] as const;

type Confirmation =
  | { kind: "clear" }
  | { kind: "close"; taskId: string; title: string }
  | {
      kind: "part";
      taskId: string;
      partId: string;
      title: string;
      focusId: string;
    };

interface TaskActions {
  onRestore: (taskId: string) => void;
  onRecover: (
    task: Task,
    action: TaskRecovery,
    onRetried: () => void,
  ) => Promise<void>;
}

function TaskOutput({
  path,
  folder,
  describedBy,
  children,
}: {
  path?: string;
  folder?: string;
  describedBy?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState<"document" | "location">();
  const [error, setError] = useState<Message>();
  const location = path ?? folder;

  async function open(action: "document" | "location") {
    const target = action === "document" ? path : (folder ?? path);
    if (!target || opening) return;

    setError(undefined);
    setOpening(action);
    try {
      if (action === "document") {
        await invoke("open_output", { path: target });
      } else {
        await revealOutput(target, Boolean(folder));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpening(undefined);
    }
  }

  return (
    <div className="task-output">
      <div className="task-actions">
        {path && (
          <button
            type="button"
            className="primary"
            aria-describedby={describedBy}
            disabled={Boolean(opening)}
            onClick={() => void open("document")}
          >
            <Icon name="document" />
            {t(opening === "document" ? "task.opening" : "task.openDocument")}
          </button>
        )}
        {location && (
          <button
            type="button"
            aria-describedby={describedBy}
            disabled={Boolean(opening)}
            onClick={() => void open("location")}
          >
            <Icon name="folder" />
            {t(
              opening === "location"
                ? "task.opening"
                : folder
                  ? "task.openFolder"
                  : "task.reveal",
            )}
          </button>
        )}
        {children}
      </div>
      {error && (
        <p className="error task-error" role="alert">
          {renderMessage(t, error)}
        </p>
      )}
      {location && (
        <details className="task-location">
          <summary aria-describedby={describedBy}>
            <Icon name="down" />
            {t("task.outputLocation")}
          </summary>
          <p className="task-output-path">{location}</p>
        </details>
      )}
    </div>
  );
}

function TaskCard({
  task,
  queue,
  onRestore,
  onRecover,
  onClose,
  onCancelPart,
}: {
  task: Task;
  queue: TaskQueue;
  onClose: (task: Task) => void;
  onCancelPart: (confirmation: Extract<Confirmation, { kind: "part" }>) => void;
} & TaskActions) {
  const { t } = useTranslation();
  const title = useRef<HTMLHeadingElement>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<Message>();
  const multipart = task.parts.length > 1;
  const singlePart = multipart ? undefined : task.parts[0];
  const singlePartLabel = singlePart?.number
    ? partLabel(
        {
          title: singlePart.title === task.title ? undefined : singlePart.title,
          number: singlePart.number,
        },
        t,
      )
    : undefined;
  const runningParts = task.parts.filter(
    (part) => part.status === "running",
  ).length;
  const phase =
    task.status === "running"
      ? singlePart?.status === "running"
        ? singlePart.phase
        : task.phase
      : undefined;
  const phases = task.mode === "transcript" ? transcriptPhases : documentPhases;
  const stage = phases.findIndex((step) => step === phase);
  const status = t(`task.status.${task.status}`);
  const failures = task.parts.filter((part) => part.status === "failed").length;
  const canRetry =
    (failures > 0 || Boolean(task.error)) && !isUnfinished(task.status);
  const modelRecovery = task.recovery.find(
    (action) => action !== "outputDirectory",
  );
  const directoryRecovery = task.recovery.includes("outputDirectory");

  function focusTitle() {
    title.current?.focus({ preventScroll: true });
  }

  async function recover(action: TaskRecovery) {
    setRecoveryError(undefined);
    setRecovering(true);
    try {
      await onRecover(task, action, focusTitle);
    } catch (error) {
      setRecoveryError(errorMessage(error));
    } finally {
      setRecovering(false);
    }
  }

  function describeFailure(error: Message, phase?: TaskPart["phase"]) {
    const detail = renderMessage(t, error);
    return phase
      ? t("task.phaseError", { phase: t(`task.phase.${phase}`), detail })
      : detail;
  }

  async function retry(partId?: string, focusId?: string) {
    setRecoveryError(undefined);
    setRecovering(true);
    try {
      if (await queue.retry(task.id, { partId })) {
        if (focusId) {
          document.getElementById(focusId)?.focus({ preventScroll: true });
        } else {
          focusTitle();
        }
      }
    } catch (error) {
      setRecoveryError(errorMessage(error));
    } finally {
      setRecovering(false);
    }
  }

  const actions = (
    <>
      {modelRecovery && (
        <button
          type="button"
          className="primary"
          disabled={recovering}
          onClick={() => void recover(modelRecovery)}
        >
          {t("task.updateModels")}
        </button>
      )}
      {directoryRecovery && (
        <button
          type="button"
          className={modelRecovery ? undefined : "primary"}
          disabled={recovering}
          onClick={() => void recover("outputDirectory")}
        >
          {t("task.changeFolder")}
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          className={modelRecovery || directoryRecovery ? undefined : "primary"}
          disabled={recovering}
          onClick={() => void retry()}
        >
          {t(multipart ? "task.retry" : "task.retryStep")}
        </button>
      )}
      {task.canRestore && (
        <button type="button" onClick={() => onRestore(task.id)}>
          {t("task.restore")}
        </button>
      )}
    </>
  );

  return (
    <li className="task enter">
      <div className="task-heading">
        <h3 ref={title} tabIndex={-1}>
          {task.title}
          {singlePartLabel && (
            <span className="task-part-subtitle">{singlePartLabel}</span>
          )}
        </h3>
        <div className="task-heading-actions">
          <span className="task-status" data-status={task.status} role="status">
            <span className="sr-only">
              {t("task.statusLabel", {
                title: singlePartLabel
                  ? `${task.title} · ${singlePartLabel}`
                  : task.title,
                status,
              })}
            </span>
            <span aria-hidden="true">{status}</span>
          </span>
          <button
            type="button"
            className="quiet icon-button task-close"
            aria-label={t("task.closeNamed", {
              title: singlePartLabel
                ? `${task.title} · ${singlePartLabel}`
                : task.title,
            })}
            title={t("task.close")}
            onClick={() => onClose(task)}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      {phase && (
        <div className="task-progress">
          <p className="muted" role="status">
            {t(`task.phase.${phase}`)}
          </p>
          <div className="phase-track" aria-hidden="true">
            {phases.map((phase, index) => (
              <span
                key={phase}
                data-stage={
                  index === stage
                    ? "current"
                    : index < stage
                      ? "done"
                      : undefined
                }
              />
            ))}
          </div>
        </div>
      )}
      {task.error && (
        <p className="error task-error">
          {describeFailure(task.error, task.phase)}
        </p>
      )}
      {multipart ? (
        <details className="task-details">
          <summary>
            <Icon name="down" />
            <span>
              {t(failures > 0 ? "task.savedWithFailures" : "task.saved", {
                saved: task.outputs.length,
                total: task.parts.length,
                failed: failures,
              })}
              {runningParts > 0 &&
                ` · ${t("task.runningParts", { count: runningParts })}`}
            </span>
          </summary>
          <ul className="task-parts">
            {task.parts.map((part, index) => {
              const partTitleId = `task-part-${task.id}-${index}`;
              const label = partLabel(part, t);
              return (
                <li className="task-part" key={part.id}>
                  <span
                    className="task-part-name"
                    id={partTitleId}
                    tabIndex={-1}
                  >
                    {label}
                  </span>
                  <div className="task-heading-actions">
                    <span className="task-status" data-status={part.status}>
                      {t(
                        part.status === "running" && part.phase
                          ? `task.phase.${part.phase}`
                          : `task.status.${part.status}`,
                      )}
                    </span>
                    {isUnfinished(part.status) && (
                      <button
                        type="button"
                        className="quiet icon-button task-close"
                        aria-label={t("task.cancelPartNamed", { title: label })}
                        title={t("task.cancelPart")}
                        onClick={() =>
                          onCancelPart({
                            kind: "part",
                            taskId: task.id,
                            partId: part.id,
                            title: label,
                            focusId: partTitleId,
                          })
                        }
                      >
                        <Icon name="close" />
                      </button>
                    )}
                  </div>
                  {part.error && (
                    <p className="error task-error">
                      {describeFailure(part.error, part.phase)}
                    </p>
                  )}
                  {(part.outputPath || part.status === "failed") && (
                    <TaskOutput
                      path={part.outputPath}
                      describedBy={partTitleId}
                    >
                      {part.status === "failed" && (
                        <button
                          type="button"
                          aria-describedby={partTitleId}
                          disabled={recovering}
                          onClick={() => void retry(part.id, partTitleId)}
                        >
                          {t("task.retryStep")}
                        </button>
                      )}
                    </TaskOutput>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ) : (
        singlePart?.error && (
          <p className="error task-error">
            {describeFailure(singlePart.error, singlePart.phase)}
          </p>
        )
      )}
      <TaskOutput path={singlePart?.outputPath} folder={task.outputDirectory}>
        {actions}
      </TaskOutput>
      {recoveryError && (
        <p className="error task-error" role="alert">
          {renderMessage(t, recoveryError)}
        </p>
      )}
    </li>
  );
}

export function TaskList({
  queue,
  onRestore,
  onRecover,
}: {
  queue: TaskQueue;
} & TaskActions) {
  const { t } = useTranslation();
  const tasks = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [actionError, setActionError] = useState<Message>();
  const orderedTasks = tasks
    .slice()
    .reverse()
    .sort(
      (a, b) => Number(b.status === "running") - Number(a.status === "running"),
    );

  useLayoutEffect(() => {
    if (confirmation && dialog.current && !dialog.current.open) {
      dialog.current.returnValue = "";
      dialog.current.showModal();
    }
  }, [confirmation]);

  async function runAction(action: Promise<void>) {
    setActionError(undefined);
    try {
      await action;
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function closeTask(task: Task) {
    if (isUnfinished(task.status)) {
      setConfirmation({ kind: "close", taskId: task.id, title: task.title });
    } else {
      heading.current?.focus({ preventScroll: true });
      void runAction(queue.remove(task.id));
    }
  }

  function finishConfirmation(element: HTMLDialogElement) {
    if (element.open) return;
    const confirmed = element.returnValue === "confirm";
    element.returnValue = "";
    setConfirmation(undefined);
    if (!confirmed || !confirmation) return;

    if (confirmation.kind === "part") {
      document
        .getElementById(confirmation.focusId)
        ?.focus({ preventScroll: true });
      void runAction(
        queue.cancelPart(confirmation.taskId, confirmation.partId),
      );
    } else {
      heading.current?.focus({ preventScroll: true });
      void runAction(
        queue.remove(
          confirmation.kind === "clear" ? undefined : confirmation.taskId,
        ),
      );
    }
  }

  return (
    <section className="queue-panel" aria-labelledby="queue-heading">
      <header className="queue-header">
        <div className="queue-heading">
          <span className="queue-heading-icon" aria-hidden="true">
            <StackSimpleIcon className="icon" />
          </span>
          <h2 id="queue-heading" ref={heading} tabIndex={-1}>
            {t("task.heading")}
          </h2>
        </div>
        {tasks.length > 0 && (
          <div className="task-heading-actions">
            <p className="queue-count">
              {t("task.count", { count: tasks.length })}
            </p>
            <button
              type="button"
              className="quiet queue-clear"
              onClick={() => setConfirmation({ kind: "clear" })}
            >
              {t("task.clear")}
            </button>
          </div>
        )}
      </header>
      {actionError && (
        <p className="error task-error" role="alert">
          {renderMessage(t, actionError)}
        </p>
      )}
      {tasks.length === 0 ? (
        <div className="queue-empty">
          <div className="queue-empty-art" aria-hidden="true">
            <span className="queue-empty-page">
              <Icon name="document" />
            </span>
          </div>
          <h3>{t("task.empty")}</h3>
        </div>
      ) : (
        <ul
          className="tasks"
          role="list"
          tabIndex={0}
          aria-label={t("task.list")}
        >
          {orderedTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              queue={queue}
              onRestore={onRestore}
              onRecover={onRecover}
              onClose={closeTask}
              onCancelPart={setConfirmation}
            />
          ))}
        </ul>
      )}
      <dialog
        ref={dialog}
        className="settings-dialog confirmation-dialog"
        aria-labelledby="queue-confirmation-title"
        aria-describedby="queue-confirmation-description"
        onClose={(event) => finishConfirmation(event.currentTarget)}
      >
        {confirmation && (
          <form method="dialog" className="settings-form">
            <header className="settings-header">
              <div>
                <h2 id="queue-confirmation-title">
                  {t(`task.confirm.${confirmation.kind}.title`)}
                </h2>
                <p id="queue-confirmation-description" className="muted">
                  {confirmation.kind === "clear"
                    ? t("task.confirm.clear.description")
                    : t(`task.confirm.${confirmation.kind}.description`, {
                        title: confirmation.title,
                      })}
                </p>
              </div>
            </header>
            <div className="settings-footer">
              <div className="actions settings-actions">
                <button type="submit" value="cancel" autoFocus>
                  {t(
                    confirmation.kind === "part"
                      ? "task.keepPart"
                      : "common.cancel",
                  )}
                </button>
                <button type="submit" value="confirm" className="queue-confirm">
                  {t(
                    confirmation.kind === "part"
                      ? "task.cancelPart"
                      : `task.${confirmation.kind}`,
                  )}
                </button>
              </div>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}
