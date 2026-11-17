import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { errorMessage, renderMessage, type Message } from "./i18n";
import { partLabel } from "./media";
import { revealOutput, type Task, type TaskQueue } from "./tasks";

const phases = ["audio", "transcription", "organization", "output"] as const;

function TaskCard({
  task,
  queue,
  onRestore,
}: {
  task: Task;
  queue: TaskQueue;
  onRestore: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const title = useRef<HTMLHeadingElement>(null);
  const [revealError, setRevealError] = useState<Message>();
  const [revealing, setRevealing] = useState(false);
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
        <h3 ref={title} tabIndex={-1}>
          {task.title}
        </h3>
        <span className="status" data-status={task.status} role="status">
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
        <p className="error task-error">{renderMessage(t, task.error)}</p>
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
                <span className="status" data-status={part.status}>
                  {t(
                    part.status === "running" && part.phase
                      ? `task.phase.${part.phase}`
                      : `task.status.${part.status}`,
                  )}
                </span>
                {part.error && (
                  <p className="error task-error">
                    {renderMessage(t, part.error)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        task.parts[0]?.error && (
          <p className="error task-error">
            {renderMessage(t, task.parts[0].error)}
          </p>
        )
      )}
      {path && (
        <p className="output-path" title={path}>
          {path}
        </p>
      )}
      <div className="actions task-actions">
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
        {canRetry && (
          <button
            type="button"
            onClick={() => {
              queue.retry(task.id);
              title.current?.focus({ preventScroll: true });
            }}
          >
            {t("task.retry")}
          </button>
        )}
        <button type="button" onClick={() => onRestore(task.id)}>
          {t("task.restore")}
        </button>
      </div>
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
}: {
  queue: TaskQueue;
  onRestore: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const tasks = useSyncExternalStore(queue.subscribe, queue.getSnapshot);

  return (
    <section className="queue-panel" aria-labelledby="queue-heading">
      <header className="queue-header">
        <h2 id="queue-heading">{t("task.heading")}</h2>
        {tasks.length > 0 && (
          <p className="muted">{t("task.count", { count: tasks.length })}</p>
        )}
      </header>
      {tasks.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-icon" aria-hidden="true">
            <Icon name="document" />
          </span>
          <h3>{t("task.empty")}</h3>
        </div>
      ) : (
        <ul className="tasks">
          {tasks
            .slice()
            .reverse()
            .map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                queue={queue}
                onRestore={onRestore}
              />
            ))}
        </ul>
      )}
    </section>
  );
}
