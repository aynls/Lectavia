import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StackSimpleIcon } from "@phosphor-icons/react/dist/csr/StackSimple";
import { invoke } from "@tauri-apps/api/core";
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
}: {
  task: Task;
  queue: TaskQueue;
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
  const runningIndex = task.parts.findIndex(
    (part) => part.status === "running",
  );
  const running = task.parts[runningIndex];
  const phase = running?.phase;
  const stage = phases.findIndex((step) => step === phase);
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

  const actions = (
    <>
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
          className={modelRecovery || directoryRecovery ? undefined : "primary"}
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
    </>
  );

  return (
    <li className="task enter">
      <div className="task-heading">
        <h3 ref={title} id={`task-${task.id}`} tabIndex={-1}>
          {task.title}
          {singlePartLabel && (
            <span className="task-part-subtitle">{singlePartLabel}</span>
          )}
        </h3>
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
      </div>
      {phase && (
        <div className="task-progress">
          <p className="muted" role="status">
            {multipart
              ? t("task.partProgress", {
                  current: runningIndex + 1,
                  total: task.parts.length,
                  phase: partLabel(
                    { title: t(`task.phase.${phase}`), number: running.number },
                    t,
                  ),
                })
              : t(`task.phase.${phase}`)}
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
            {task.parts.map((part, index) => {
              const partTitleId = `task-part-${task.id}-${index}`;
              return (
                <li className="task-part" key={part.id}>
                  <span className="task-part-name" id={partTitleId}>
                    {partLabel(part, t)}
                  </span>
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
                  {part.outputPath && (
                    <TaskOutput
                      path={part.outputPath}
                      describedBy={partTitleId}
                    />
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
