import { useRef, useState, useSyncExternalStore } from "react";
import { StackSimpleIcon } from "@phosphor-icons/react/dist/csr/StackSimple";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { errorMessage, renderMessage, type Message } from "./i18n";
import { partLabel } from "./media";
import {
  revealOutput,
  type Task,
  type TaskQueue,
  type TaskRecovery,
} from "./tasks";
import "./TaskList.css";

const phases = ["audio", "transcription", "organization", "output"] as const;

interface TaskActions {
  onRestore: (taskId: string) => void;
  onRecover: (
    task: Task,
    action: TaskRecovery,
    onRetried: () => void,
  ) => Promise<void>;
}

function TaskCard({
  task,
  queue,
  onRestore,
  onRecover,
}: {
  task: Task;
  queue: TaskQueue;
} & TaskActions) {
  const { t } = useTranslation();
  const title = useRef<HTMLHeadingElement>(null);
  const [revealError, setRevealError] = useState<Message>();
  const [revealing, setRevealing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<Message>();
  const path = task.outputs.length
    ? (task.outputDirectory ?? task.outputs[0])
    : undefined;
  const multipart = task.parts.length > 1;
  const runningIndex = task.parts.findIndex(
    (part) => part.status === "running",
  );
  const running = task.parts[runningIndex];
  const stage = phases.findIndex((phase) => phase === running?.phase);
  const status = t(`task.status.${task.status}`);
  const failures = task.parts.filter((part) => part.status === "failed").length;
  const canRetry = task.status === "partial" || task.status === "failed";
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

  function describeFailure(error: Message, phase?: Task["failurePhase"]) {
    const detail = renderMessage(t, error);
    return phase
      ? t("task.phaseError", { phase: t(`task.phase.${phase}`), detail })
      : detail;
  }

  async function reveal() {
    if (!path || revealing) return;

    setRevealError(undefined);
    setRevealing(true);
    try {
      await revealOutput(path, Boolean(task.outputDirectory));
    } catch (error) {
      setRevealError(errorMessage(error));
    } finally {
      setRevealing(false);
    }
  }

  return (
    <li className="task enter">
      <div className="task-heading">
        <h3 ref={title} id={`task-${task.id}`} tabIndex={-1}>
          {task.title}
        </h3>
        <span className="task-status" data-status={task.status} role="status">
          <span className="sr-only">
            {t("task.statusLabel", { title: task.title, status })}
          </span>
          <span aria-hidden="true">{status}</span>
        </span>
      </div>
      {stage >= 0 && (
        <div className="task-progress">
          <p className="muted" role="status">
            {partLabel(
              {
                title: t(`task.phase.${phases[stage]}`),
                number: multipart
                  ? (running.number ?? runningIndex + 1)
                  : undefined,
              },
              t,
            )}
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
          {describeFailure(task.error, task.failurePhase)}
        </p>
      )}
      {multipart ? (
        <details className="task-details">
          <summary>
            <Icon name="down" />
            {t(failures > 0 ? "task.savedWithFailures" : "task.saved", {
              saved: task.outputs.length,
              total: task.parts.length,
              failed: failures,
            })}
          </summary>
          <ul className="task-parts">
            {task.parts.map((part) => (
              <li className="task-part" key={part.id}>
                <span className="task-part-name">{partLabel(part, t)}</span>
                <span className="task-status" data-status={part.status}>
                  {t(
                    part.status === "running" && part.phase
                      ? `task.phase.${part.phase}`
                      : `task.status.${part.status}`,
                  )}
                </span>
                {part.error && (
                  <p className="error task-error">
                    {describeFailure(part.error, part.phase)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        task.parts[0]?.error && (
          <p className="error task-error">
            {describeFailure(task.parts[0].error, task.parts[0].phase)}
          </p>
        )
      )}
      {path && <p className="task-output-path">{path}</p>}
      <div className="task-actions">
        {path && (
          <button
            type="button"
            onClick={() => void reveal()}
            disabled={revealing}
          >
            <Icon name="folder" />
            {t(
              revealing
                ? "task.opening"
                : task.outputDirectory
                  ? "task.openFolder"
                  : "task.reveal",
            )}
          </button>
        )}
        {modelRecovery && (
          <button
            type="button"
            className="primary"
            aria-haspopup="dialog"
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
            className={
              modelRecovery || directoryRecovery ? undefined : "primary"
            }
            disabled={recovering}
            onClick={() => {
              setRecoveryError(undefined);
              if (queue.retry(task.id)) focusTitle();
            }}
          >
            {t("task.retry")}
          </button>
        )}
        <button
          type="button"
          className="quiet"
          onClick={() => onRestore(task.id)}
        >
          {t("task.restore")}
        </button>
      </div>
      {recoveryError && (
        <p className="error task-error" role="alert">
          {renderMessage(t, recoveryError)}
        </p>
      )}
      {revealError && (
        <p className="error task-error" role="alert">
          {renderMessage(t, revealError)}
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
  const orderedTasks = tasks
    .slice()
    .reverse()
    .sort(
      (a, b) => Number(b.status === "running") - Number(a.status === "running"),
    );

  return (
    <section className="queue-panel" aria-labelledby="queue-heading">
      <header className="queue-header">
        <div className="queue-heading">
          <span className="queue-heading-icon" aria-hidden="true">
            <StackSimpleIcon className="icon" />
          </span>
          <h2 id="queue-heading">{t("task.heading")}</h2>
        </div>
        {tasks.length > 0 && (
          <p className="queue-count">
            {t("task.count", { count: tasks.length })}
          </p>
        )}
      </header>
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
            />
          ))}
        </ul>
      )}
    </section>
  );
}
