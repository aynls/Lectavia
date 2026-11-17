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
  type AudioChunks,
  type MediaInfo,
  type MediaPart,
} from "./media";
import {
  organizeTranscript,
  transcribeAudio,
  type ModelConnection,
} from "./models";
import type { OutputLanguage } from "./output-language";

type OutputFormat = "md" | "txt";
type PartStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
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
  outputLanguage: OutputLanguage;
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
  cancellation: AbortController;
  run?: PartRun;
  audio?: AudioChunks;
  transcript?: string;
  material?: string;
}

interface PartRun {
  id: string;
  registered: Promise<void>;
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

const unusableAudioErrors = new Set<MessageKey>([
  "error.cacheAccess",
  "error.audioChunkMissing",
  "error.audioChunkRestricted",
  "error.audioChunkOpen",
  "error.audioChunkMetadata",
  "error.audioChunkEmpty",
  "error.audioChunkTooLarge",
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

async function releaseAudio(part: QueuedPart): Promise<void> {
  const audio = part.audio;
  part.audio = undefined;
  if (audio) await removeAudio(audio).catch(() => undefined);
}

function endRun({ id, registered }: PartRun): void {
  void registered
    .then(() => invoke("end_task_run", { runId: id }))
    .catch(() => undefined);
}

async function releasePart(part: QueuedPart): Promise<void> {
  part.transcript = undefined;
  part.material = undefined;
  await releaseAudio(part);
}

function stopPart(part: QueuedPart): void {
  if (part.cancellation.signal.aborted) return;
  part.cancellation.abort();
  if (part.run) endRun(part.run);
  else void releasePart(part);
}

export function isUnfinished(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

function taskStatus(parts: readonly TaskPart[], completed: number): TaskStatus {
  if (parts.some((part) => part.status === "running")) return "running";
  if (parts.some((part) => part.status === "queued")) return "queued";
  if (completed === parts.length) return "completed";
  if (completed > 0) return "partial";
  return parts.some((part) => part.status === "failed")
    ? "failed"
    : "cancelled";
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

  remove(taskId: string): void {
    const job = this.#jobs.get(taskId);
    if (!job) return;

    this.#jobs.delete(taskId);
    this.#pending = this.#pending.filter((pending) => pending.job !== job);
    job.parts.forEach(stopPart);
    this.publish();
  }

  clear(): void {
    const jobs = Array.from(this.#jobs.values());
    this.#jobs.clear();
    this.#pending = [];
    jobs.forEach((job) => job.parts.forEach(stopPart));
    this.publish();
  }

  cancelPart(taskId: string, partId: string): void {
    const job = this.#jobs.get(taskId);
    if (!job) return;
    const index = job.task.parts.findIndex((part) => part.id === partId);
    if (index < 0 || !isUnfinished(job.task.parts[index].status)) return;

    this.#pending = this.#pending.filter(
      (pending) => pending.job !== job || pending.index !== index,
    );
    stopPart(job.parts[index]);
    this.updatePart(job, index, { status: "cancelled", phase: undefined });
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
          cancellation: new AbortController(),
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
    this.schedule(
      job,
      parts.map((_, index) => index),
    );
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
    // Finished stages remain reusable. Only stages that run again use the new connections.
    job.request = {
      ...job.request,
      asr: updates.asr ? { ...updates.asr } : job.request.asr,
      llm: updates.llm ? { ...updates.llm } : job.request.llm,
      outputDirectory: updates.outputDirectory ?? job.request.outputDirectory,
    };
    return this.requeueFailedParts(job);
  }

  retryPart(taskId: string, partId: string): boolean {
    const job = this.#jobs.get(taskId);
    return job ? this.requeueFailedParts(job, partId) : false;
  }

  private requeueFailedParts(job: Job, partId?: string): boolean {
    const indices: number[] = [];
    const parts = job.task.parts.map((part, index): TaskPart => {
      if (
        part.status !== "failed" ||
        (partId !== undefined && part.id !== partId)
      ) {
        return part;
      }
      indices.push(index);
      return { ...part, status: "queued", phase: undefined, error: undefined };
    });
    if (indices.length === 0) return false;

    job.task = {
      ...job.task,
      status: taskStatus(parts, job.task.outputs.length),
      parts,
      recovery: [],
    };
    this.schedule(job, indices);
    return true;
  }

  private schedule(job: Job, indices: number[]): void {
    for (const index of indices) {
      this.#pending.push({ job, index });
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
    const part = job.parts[index];
    const runId = crypto.randomUUID();
    const run = {
      id: runId,
      registered: invoke<void>("begin_task_run", { runId }),
    };
    part.run = run;
    try {
      await this.runPart(job, index, run);
    } finally {
      if (part.run === run) part.run = undefined;
      if (part.cancellation.signal.aborted) await releasePart(part);
      else endRun(run);
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
    )
      .then((directory) => {
        job.multipartDirectory = directory;
        return directory;
      })
      .finally(() => {
        job.preparingDirectory = undefined;
      }));
  }

  private async runPart(job: Job, index: number, run: PartRun): Promise<void> {
    const { asr, llm, format, outputDirectory, media, locale } = job.request;
    const part = job.parts[index];
    const { signal } = part.cancellation;
    const t = translator(locale);
    const partTitle =
      part.media.title ??
      (part.media.number
        ? t("media.part", { number: part.media.number })
        : job.task.title);
    const setPhase = (phase: Phase) => {
      signal.throwIfAborted();
      this.updatePart(job, index, { status: "running", phase });
      signal.throwIfAborted();
    };

    try {
      this.updatePart(job, index, { status: "running" });
      await run.registered;
      signal.throwIfAborted();
      let directory = job.multipartDirectory;
      if (media.multipart && !directory) {
        directory = await this.prepareMultipartDirectory(job);
      }
      if (part.material === undefined) {
        if (part.transcript === undefined) {
          if (part.audio === undefined) {
            setPhase("audio");
            part.audio = await prepareAudio(part.media, run.id);
          }

          setPhase("transcription");
          part.transcript = await transcribeAudio(
            part.audio.files,
            asr,
            run.id,
          );
          await releaseAudio(part);
        }

        setPhase("organization");
        part.material = await organizeTranscript(
          part.transcript,
          {
            connection: llm,
            locale,
            outputLanguage: job.request.outputLanguage,
            videoTitle: media.title,
            partTitle: media.multipart ? partLabel(part.media, t) : undefined,
            description: media.description,
            format,
            instructions: job.instructions,
          },
          run.id,
        );
        part.transcript = undefined;
      }

      setPhase("output");
      const outputPath = await invoke<string>("write_task_output", {
        runId: run.id,
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
      signal.throwIfAborted();
      part.material = undefined;
      this.updatePart(job, index, {
        status: "completed",
        phase: undefined,
        outputPath,
        outputDirectory: directory,
      });
    } catch (error) {
      if (signal.aborted) return;
      const phase = job.task.parts[index].phase ?? "output";
      const failure = failureMessage(error, job);
      if (
        phase === "transcription" &&
        hasErrorKey(failure, unusableAudioErrors)
      ) {
        await releaseAudio(part);
      }
      if (signal.aborted) return;
      this.updatePart(job, index, {
        status: "failed",
        phase,
        error: failure,
      });
    }
  }
}
