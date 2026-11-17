import { invoke } from "@tauri-apps/api/core";
import {
  errorMessage,
  message,
  redactMessage,
  translator,
  type Locale,
  type Message,
  type MessageKey,
} from "./i18n";
import {
  partLabel,
  prepareAudio,
  removeAudio,
  type MediaInfo,
  type MediaPart,
} from "./media";
import {
  organizeTranscript,
  transcribeAudio,
  type ModelConnection,
} from "./models";

type OutputFormat = "md" | "txt";
type PartStatus = "queued" | "running" | "completed" | "failed";
type TaskStatus = PartStatus | "partial";
type Phase = "audio" | "transcription" | "organization" | "output";

export type TaskRecovery = "asr" | "llm" | "outputDirectory";

export interface PromptFile {
  name: string;
  content: string;
}

export interface TaskRequest {
  link: string;
  media: MediaInfo;
  selectedParts: string[];
  outputDirectory: string;
  locale: Locale;
  format: OutputFormat;
  instructions: string;
  prompt: PromptFile | null;
  asr: ModelConnection;
  llm: ModelConnection;
}

export type TaskRetryUpdates = Partial<Pick<TaskRequest, TaskRecovery>>;

export interface TaskPart {
  readonly id: string;
  readonly title?: string;
  readonly number?: number;
  readonly status: PartStatus;
  readonly phase?: Phase;
  readonly error?: Message;
  readonly outputPath?: string;
  readonly outputDirectory?: string;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly parts: readonly TaskPart[];
  readonly outputs: readonly string[];
  readonly outputDirectory?: string;
  readonly recovery: readonly TaskRecovery[];
}

interface QueuedPart {
  media: MediaPart;
  transcript?: string;
  material?: string;
}

interface Job {
  task: Task;
  request: TaskRequest;
  parts: QueuedPart[];
  instructions?: string;
  multipartDirectory?: string;
  preparingDirectory?: Promise<string>;
}

interface PendingPart {
  job: Job;
  index: number;
}

const modelSettingErrors = new Set<MessageKey>([
  "error.baseUrl",
  "error.baseUrlHasRoute",
  "error.credentials",
  "error.apiKey",
  "error.modelId",
  "error.providerConnect",
  "error.providerJson",
  "error.httpBadRequest",
  "error.httpAccess",
  "error.httpNotFound",
  "error.httpPayment",
  "error.httpRedirect",
  "error.transcriptionMissing",
  "error.outputLength",
  "error.modelEmpty",
]);

const directoryErrors = new Set<MessageKey>([
  "error.folderInvalid",
  "error.folderNotWritable",
  "error.folderCreate",
  "error.outputTemp",
  "error.outputWrite",
  "error.outputSave",
]);

function hasErrorKey(error: Message, keys: ReadonlySet<MessageKey>): boolean {
  return (
    keys.has(error.key) ||
    Object.values(error.values ?? {}).some(
      (value) => typeof value === "object" && hasErrorKey(value, keys),
    )
  );
}

function recoveryFor(error: Message, phase?: Phase): TaskRecovery | undefined {
  if (phase === "output" && hasErrorKey(error, directoryErrors)) {
    return "outputDirectory";
  }
  if (
    (phase === "transcription" || phase === "organization") &&
    hasErrorKey(error, modelSettingErrors)
  ) {
    return phase === "transcription" ? "asr" : "llm";
  }
}

function failureMessage(error: unknown, job: Job): Message {
  return redactMessage(errorMessage(error, "error.taskFailed"), [
    job.request.asr.apiKey,
    job.request.llm.apiKey,
  ]);
}

function taskStatus(parts: readonly TaskPart[], completed: number): TaskStatus {
  if (parts.some((part) => part.status === "running")) return "running";
  if (parts.some((part) => part.status === "queued")) return "queued";
  if (completed === parts.length) return "completed";
  return completed > 0 ? "partial" : "failed";
}

export function revealOutput(
  path: string,
  isDirectory: boolean,
): Promise<void> {
  return invoke("reveal_output", { path, isDirectory });
}

export class TaskQueue {
  #jobs = new Map<string, Job>();
  #pending: PendingPart[] = [];
  #active = 0;
  #maxConcurrency: number | null;
  #listeners = new Set<() => void>();
  #snapshot: readonly Task[] = [];

  constructor(maxConcurrency: number | null = null) {
    this.#maxConcurrency = maxConcurrency;
  }

  get maxConcurrency(): number | null {
    return this.#maxConcurrency;
  }

  setMaxConcurrency(limit: number | null): void {
    this.#maxConcurrency = limit;
    this.drain();
  }

  getSnapshot = (): readonly Task[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getRequest(taskId: string): TaskRequest | undefined {
    const job = this.#jobs.get(taskId);
    return job && structuredClone(job.request);
  }

  enqueue(input: TaskRequest): void {
    const request = structuredClone(input);
    const selected = new Set(request.selectedParts);
    const parts = request.media.parts.flatMap((part, index) => {
      if (!selected.has(part.id)) return [];

      return [
        {
          media: {
            ...part,
            number: request.media.multipart
              ? (part.number ?? index + 1)
              : undefined,
          },
        },
      ];
    });

    if (parts.length === 0) throw message("error.noPartSelected");
    if (!request.outputDirectory) throw message("error.noFolderSelected");

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
      recovery: [],
    };

    const instructions = [
      request.instructions.trim(),
      request.prompt?.content.trim() ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const job: Job = {
      task,
      request,
      parts,
      instructions: instructions || undefined,
    };
    this.#jobs.set(task.id, job);
    this.schedule(job);
  }

  retry(taskId: string, updates: TaskRetryUpdates = {}): boolean {
    const job = this.#jobs.get(taskId);
    if (
      !job ||
      (job.task.status !== "partial" && job.task.status !== "failed") ||
      (updates.outputDirectory !== undefined && !updates.outputDirectory.trim())
    ) {
      return false;
    }

    // Explicitly choosing a destination also recovers a removed multipart folder.
    if (updates.outputDirectory !== undefined) {
      job.multipartDirectory = undefined;
    }
    job.preparingDirectory = undefined;
    // Finished stages remain reusable. Only stages that run again use the new connections.
    job.request = {
      ...job.request,
      asr: updates.asr ? { ...updates.asr } : job.request.asr,
      llm: updates.llm ? { ...updates.llm } : job.request.llm,
      outputDirectory: updates.outputDirectory ?? job.request.outputDirectory,
    };
    job.task = {
      ...job.task,
      status: "queued",
      recovery: [],
      parts: job.task.parts.map((part) =>
        part.status === "failed"
          ? { ...part, status: "queued", phase: undefined, error: undefined }
          : part,
      ),
    };
    this.schedule(job);
    return true;
  }

  private schedule(job: Job): void {
    for (const [index, part] of job.task.parts.entries()) {
      if (part.status === "queued") this.#pending.push({ job, index });
    }
    this.publish();
    this.drain();
  }

  private publish(): void {
    this.#snapshot = Array.from(this.#jobs.values(), ({ task }) => task);
    this.#listeners.forEach((listener) => listener());
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
    const outputDirectories = Array.from(
      new Set(
        parts.flatMap((part) =>
          part.outputDirectory ? [part.outputDirectory] : [],
        ),
      ),
    );
    const status = taskStatus(parts, outputs.length);
    const recovery = new Set<TaskRecovery>();
    if (status === "failed" || status === "partial") {
      for (const part of parts) {
        if (part.status !== "failed" || !part.error) continue;
        const action = recoveryFor(part.error, part.phase);
        if (action) recovery.add(action);
      }
    }
    job.task = {
      ...job.task,
      status,
      parts,
      outputs,
      outputDirectory:
        outputDirectories.length === 1 ? outputDirectories[0] : undefined,
      recovery: Array.from(recovery),
    };
    this.publish();
  }

  private drain(): void {
    while (this.#active < (this.#maxConcurrency ?? Infinity)) {
      const pending = this.#pending.shift();
      if (!pending) return;
      this.#active += 1;
      void this.runScheduledPart(pending);
    }
  }

  private async runScheduledPart({ job, index }: PendingPart): Promise<void> {
    try {
      await this.runPart(job, index);
    } finally {
      this.#active -= 1;
      this.drain();
    }
  }

  private prepareMultipartDirectory(job: Job): Promise<string> {
    // All selected parts write to the same directory, including on retry.
    return (job.preparingDirectory ??= invoke<string>(
      "create_output_directory",
      {
        directory: job.request.outputDirectory,
        title: job.task.title,
        fallbackTitle: translator(job.request.locale)("output.fallbackTitle"),
      },
    ).then((directory) => {
      job.multipartDirectory = directory;
      return directory;
    }));
  }

  private async runPart(job: Job, index: number): Promise<void> {
    const { asr, llm, format, outputDirectory, media, locale } = job.request;
    const part = job.parts[index];
    const t = translator(locale);
    const partTitle =
      part.media.title ??
      (part.media.number
        ? t("media.part", { number: part.media.number })
        : job.task.title);
    let phase: Phase = "output";
    const setPhase = (next: Phase) => {
      phase = next;
      this.updatePart(job, index, { status: "running", phase });
    };

    try {
      let directory = job.multipartDirectory;
      if (media.multipart && !directory) {
        this.updatePart(job, index, { status: "running" });
        directory = await this.prepareMultipartDirectory(job);
      }
      if (part.material === undefined) {
        if (part.transcript === undefined) {
          setPhase("audio");
          const audio = await prepareAudio(part.media);

          try {
            setPhase("transcription");
            part.transcript = await transcribeAudio(audio.files, asr);
          } finally {
            // Cleanup errors never replace the result of transcription.
            await removeAudio(audio).catch(() => undefined);
          }
        }

        setPhase("organization");
        part.material = await organizeTranscript(part.transcript, {
          connection: llm,
          locale,
          videoTitle: media.title,
          partTitle: media.multipart ? partLabel(part.media, t) : undefined,
          description: media.description,
          format,
          instructions: job.instructions,
        });
        part.transcript = undefined;
      }

      setPhase("output");
      const outputPath = await invoke<string>("write_output", {
        directory: directory ?? outputDirectory,
        title: media.multipart ? partTitle : job.task.title,
        labels: {
          fallbackTitle: t("output.fallbackTitle"),
          documentSuffix: t("output.suffix"),
        },
        format,
        content: part.material,
        partIndex: part.media.number,
      });
      part.material = undefined;
      this.updatePart(job, index, {
        status: "completed",
        phase: undefined,
        outputPath,
        outputDirectory: directory,
      });
    } catch (error) {
      this.updatePart(job, index, {
        status: "failed",
        phase,
        error: failureMessage(error, job),
      });
    }
  }
}
