import { useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import {
  revealOutput,
  type Task,
  type TaskPart,
  type TaskQueue,
} from "./tasks";

const statusLabels = {
  queued: "排队中",
  running: "处理中",
  completed: "已完成",
  failed: "失败",
  partial: "部分完成",
};

const phases = [
  { id: "audio", label: "提取音轨" },
  { id: "transcription", label: "语音转写" },
  { id: "organization", label: "整理文稿" },
  { id: "output", label: "保存文件" },
] as const;

function partStatus(part: TaskPart) {
  return (
    phases.find((phase) => phase.id === part.phase && part.status === "running")
      ?.label ?? statusLabels[part.status]
  );
}

function TaskCard({ task, queue }: { task: Task; queue: TaskQueue }) {
  const title = useRef<HTMLHeadingElement>(null);
  const [revealError, setRevealError] = useState("");
  const [revealing, setRevealing] = useState(false);
  const path = task.outputs.length
    ? (task.outputDirectory ?? task.outputs[0])
    : undefined;
  const multipart = task.parts.length > 1;
  const runningIndex = task.parts.findIndex(
    (part) => part.status === "running",
  );
  const running = task.parts[runningIndex];
  const stage = phases.findIndex((phase) => phase.id === running?.phase);
  const failures = task.parts.filter((part) => part.status === "failed").length;
  const canRetry = task.status === "partial" || task.status === "failed";

  async function reveal() {
    if (!path || revealing) return;

    setRevealError("");
    setRevealing(true);
    try {
      await revealOutput(path, Boolean(task.outputDirectory));
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
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
          <span className="sr-only">{task.title}：</span>
          {statusLabels[task.status]}
        </span>
      </div>
      {stage >= 0 && (
        <div className="task-progress">
          <p className="muted" role="status">
            {multipart && `P${running.number ?? runningIndex + 1} · `}
            {phases[stage].label}
          </p>
          <div className="phase-track" aria-hidden="true">
            {phases.map((phase, index) => (
              <span
                key={phase.id}
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
      {task.error && <p className="error task-error">{task.error}</p>}
      {multipart ? (
        <details className="task-details">
          <summary>
            <Icon name="down" />
            已保存 {task.outputs.length} / {task.parts.length} 份
            {failures > 0 && ` · ${failures} 项失败`}
          </summary>
          <ul className="task-parts">
            {task.parts.map((part) => (
              <li className="task-part" key={part.id}>
                <span className="task-part-name">
                  {part.number ? `P${part.number} · ` : ""}
                  {part.title}
                </span>
                <span className="status" data-status={part.status}>
                  {partStatus(part)}
                </span>
                {part.error && <p className="error task-error">{part.error}</p>}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        task.parts[0]?.error && (
          <p className="error task-error">{task.parts[0].error}</p>
        )
      )}
      {path && (
        <p className="output-path" title={path}>
          {path}
        </p>
      )}
      {(path || canRetry) && (
        <div className="actions task-actions">
          {path && (
            <button
              type="button"
              onClick={() => void reveal()}
              disabled={revealing}
            >
              <Icon name="folder" />
              {revealing
                ? "正在打开…"
                : task.outputDirectory
                  ? "打开输出目录"
                  : "定位文稿"}
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
              重试失败项
            </button>
          )}
        </div>
      )}
      {revealError && (
        <p className="error task-error" role="alert">
          {revealError}
        </p>
      )}
    </li>
  );
}

export function TaskList({ queue }: { queue: TaskQueue }) {
  const tasks = useSyncExternalStore(queue.subscribe, queue.getSnapshot);

  return (
    <section className="queue-panel" aria-labelledby="queue-heading">
      <header className="queue-header">
        <h2 id="queue-heading">任务队列</h2>
        {tasks.length > 0 && <p className="muted">{tasks.length} 项任务</p>}
      </header>
      {tasks.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-icon" aria-hidden="true">
            <Icon name="document" />
          </span>
          <h3>还没有任务</h3>
          <p className="muted">生成后可在这里查看进度并打开文稿。</p>
        </div>
      ) : (
        <ul className="tasks">
          {tasks
            .slice()
            .reverse()
            .map((task) => (
              <TaskCard key={task.id} task={task} queue={queue} />
            ))}
        </ul>
      )}
    </section>
  );
}
