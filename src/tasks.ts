import { invoke } from "@tauri-apps/api/core";
import {
  prepareAudio,
  removeAudio,
  type MediaInfo,
  type MediaPart,
} from "./media";
import {
  organizeStudyMaterial,
  transcribeAudio,
  type ModelConnection,
} from "./models";

type OutputFormat = "md" | "txt";
type PartStatus = "queued" | "running" | "completed" | "failed";
type TaskStatus = PartStatus | "partial";
type Phase = "audio" | "transcription" | "organization" | "output";

export interface TaskRequest {
  media: MediaInfo;
  parts: MediaPart[];
  outputDirectory: string;
  format: OutputFormat;
  instructions?: string;
  asr: ModelConnection;
  llm: ModelConnection;
}

export interface TaskPart {
  readonly id: string;
  readonly title: string;
  readonly number?: number;
  readonly status: PartStatus;
  readonly phase?: Phase;
  readonly error?: string;
  readonly outputPath?: string;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly parts: readonly TaskPart[];
  readonly outputs: readonly string[];
  readonly outputDirectory?: string;
  readonly error?: string;
}

interface QueuedPart {
  media: MediaPart;
  transcript?: string;
  material?: string;
}

interface Job {
  task: Task;
  parts: QueuedPart[];
  multipart: boolean;
  outputDirectory: string;
  format: OutputFormat;
  instructions?: string;
  asr: ModelConnection;
  llm: ModelConnection;
}

function failureMessage(error: unknown, job: Job): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "任务处理失败。";

  return [job.asr.apiKey, job.llm.apiKey].reduce(
    (detail, key) => (key ? detail.replaceAll(key, "[已隐藏]") : detail),
    message,
  );
}

export function revealOutput(
  path: string,
  isDirectory: boolean,
): Promise<void> {
  return invoke("reveal_output", { path, isDirectory });
}

export class TaskQueue {
  #jobs = new Map<string, Job>();
  #pending: Job[] = [];
  #running = false;
  #listeners = new Set<() => void>();
  #snapshot: readonly Task[] = [];

  getSnapshot = (): readonly Task[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  enqueue(request: TaskRequest): void {
    const selected = new Set(request.parts.map((part) => part.id));
    const parts = request.media.parts.flatMap((part, index) => {
      if (!selected.has(part.id)) return [];

      return [
        {
          media: {
            ...part,
            number: request.media.multipart
              ? (part.number ?? index + 1)
              : undefined,
            source: { ...part.source },
          },
        },
      ];
    });

    if (parts.length === 0) throw new Error("请至少选择一个视频分段。");
    if (!request.outputDirectory) throw new Error("请选择保存目录。");

    const task: Task = {
      id: crypto.randomUUID(),
      title: request.media.title,
      status: "queued",
      parts: parts.map(({ media: part }) => ({
        id: part.id,
        title: part.title,
        number: part.number,
        status: "queued",
      })),
      outputs: [],
    };

    const job: Job = {
      task,
      parts,
      multipart: request.media.multipart,
      outputDirectory: request.outputDirectory,
      format: request.format,
      instructions: request.instructions,
      asr: { ...request.asr },
      llm: { ...request.llm },
    };
    this.#jobs.set(task.id, job);
    this.#pending.push(job);
    this.publish();
    void this.drain();
  }

  retry(taskId: string): void {
    const job = this.#jobs.get(taskId);
    if (
      !job ||
      (job.task.status !== "partial" && job.task.status !== "failed")
    ) {
      return;
    }

    this.#pending.push(job);
    this.update(job, {
      status: "queued",
      error: undefined,
      parts: job.task.parts.map((part) =>
        part.status === "failed"
          ? { ...part, status: "queued", phase: undefined, error: undefined }
          : part,
      ),
    });
    void this.drain();
  }

  private publish(): void {
    this.#snapshot = Array.from(this.#jobs.values(), ({ task }) => task);
    this.#listeners.forEach((listener) => listener());
  }

  private update(job: Job, changes: Partial<Task>): void {
    job.task = { ...job.task, ...changes };
    this.publish();
  }

  private updatePart(
    job: Job,
    index: number,
    changes: Partial<TaskPart>,
  ): void {
    const parts = job.task.parts.map((part, position) =>
      index === position ? { ...part, ...changes } : part,
    );
    const outputs = parts.flatMap((part) =>
      part.outputPath ? [part.outputPath] : [],
    );
    this.update(job, { parts, outputs });
  }

  private async drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    try {
      let job: Job | undefined;
      while ((job = this.#pending.shift())) {
        await this.runJob(job);
      }
    } finally {
      this.#running = false;
    }
  }

  private async runJob(job: Job): Promise<void> {
    this.update(job, { status: "running" });

    if (job.multipart && !job.task.outputDirectory) {
      try {
        const outputDirectory = await invoke<string>(
          "create_output_directory",
          {
            directory: job.outputDirectory,
            title: job.task.title,
          },
        );
        this.update(job, { outputDirectory });
      } catch (error) {
        this.update(job, {
          status: "failed",
          error: failureMessage(error, job),
          parts: job.task.parts.map((part) => ({ ...part, status: "failed" })),
        });
        return;
      }
    }

    for (const [index, part] of job.task.parts.entries()) {
      if (part.status === "queued") await this.runPart(job, index);
    }

    const { parts, outputs } = job.task;
    const status =
      outputs.length === parts.length
        ? "completed"
        : outputs.length > 0
          ? "partial"
          : "failed";
    this.update(job, { status });
  }

  private async runPart(job: Job, index: number): Promise<void> {
    const part = job.parts[index];
    const setPhase = (phase: Phase) =>
      this.updatePart(job, index, { status: "running", phase });

    try {
      if (part.material === undefined) {
        if (part.transcript === undefined) {
          setPhase("audio");
          const audio = await prepareAudio(part.media);

          try {
            setPhase("transcription");
            part.transcript = await transcribeAudio(audio.files, job.asr);
          } finally {
            // Cleanup errors never replace the result of transcription.
            await removeAudio(audio).catch(() => undefined);
          }
        }

        setPhase("organization");
        part.material = await organizeStudyMaterial(part.transcript, {
          connection: job.llm,
          title: part.media.title || job.task.title,
          format: job.format,
          instructions: job.instructions,
        });
        part.transcript = undefined;
      }

      setPhase("output");
      const outputPath = await invoke<string>("write_output", {
        directory: job.task.outputDirectory ?? job.outputDirectory,
        title: job.multipart ? part.media.title : job.task.title,
        format: job.format,
        content: part.material,
        partIndex: part.media.number,
      });
      part.material = undefined;
      this.updatePart(job, index, {
        status: "completed",
        phase: undefined,
        outputPath,
      });
    } catch (error) {
      this.updatePart(job, index, {
        status: "failed",
        error: failureMessage(error, job),
      });
    }
  }
}
