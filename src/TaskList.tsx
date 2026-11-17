import { useState, useSyncExternalStore } from "react";
import { revealOutput, type Task, type TaskQueue } from "./tasks";

const statusLabels = {
  queued: "等待中",
  running: "处理中",
  completed: "已完成",
  failed: "失败",
  partial: "部分完成",
};

const phaseLabels = {
  audio: "提取音轨",
  transcription: "语音转写",
  organization: "整理资料",
  output: "保存文件",
};

export function TaskList({ queue }: { queue: TaskQueue }) {
  const tasks = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [revealError, setRevealError] = useState("");

  async function reveal(task: Task) {
    const path = task.outputDirectory ?? task.outputs[0];
    if (!path) return;

    setRevealError("");
    try {
      await revealOutput(path, Boolean(task.outputDirectory));
    } catch (error) {
      setRevealError(String(error instanceof Error ? error.message : error));
    }
  }

  return (
    <section className="panel queue-panel" aria-labelledby="queue-heading">
      <h2 id="queue-heading">任务队列</h2>
      {tasks.length === 0 ? (
        <p className="muted queue-empty">
          提交视频后，可以在这里查看进度和成品。
        </p>
      ) : (
        <ul className="tasks">
          {tasks.map((task) => (
            <li key={task.id} className="task">
              <div className="task-heading">
                <h3>{task.title}</h3>
                <span className="status" data-status={task.status}>
                  {statusLabels[task.status]}
                </span>
              </div>
              {task.error && <p className="error">{task.error}</p>}
              <ul className="task-parts">
                {task.parts.map((part) => (
                  <li key={part.id}>
                    {task.parts.length > 1 && (
                      <span className="task-part-name">
                        {part.number ? `P${part.number} · ` : ""}
                        {part.title}
                      </span>
                    )}
                    <span className="muted">
                      {part.status === "running" && part.phase
                        ? phaseLabels[part.phase]
                        : statusLabels[part.status]}
                    </span>
                    {part.error && <p className="error">{part.error}</p>}
                  </li>
                ))}
              </ul>
              {task.outputs.length > 0 && (
                <p className="output-path">
                  {task.outputDirectory ?? task.outputs[0]}
                </p>
              )}
              <div className="actions">
                {task.outputs.length > 0 && (
                  <button type="button" onClick={() => void reveal(task)}>
                    {task.outputDirectory ? "打开成品目录" : "定位成品"}
                  </button>
                )}
                {(task.status === "partial" || task.status === "failed") && (
                  <button type="button" onClick={() => queue.retry(task.id)}>
                    重试失败项
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {revealError && (
        <p className="error" role="alert">
          {revealError}
        </p>
      )}
    </section>
  );
}
