import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Locale, Message, MessageKey } from "./i18n";
import type { VideoPreview } from "./media";

export type OutputFormat = "md" | "txt";
type PartStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type TaskStatus = PartStatus | "partial";
type Phase = "inspect" | "audio" | "transcription" | "organization" | "output";

export type TaskRecovery = "asr" | "llm" | "outputDirectory";

export interface PromptFile {
  name: string;
  content: string;
}

export interface TaskRequest {
  request_id: string;
  video: string;
  parts?: number[];
  output_directory: string;
  locale: Locale;
  output_language: string;
  format: OutputFormat;
  instructions?: string;
}

export interface TaskDraft {
  request: Pick<TaskRequest, "video" | "output_directory"> & {
    parts: number[] | null;
    format: OutputFormat | null;
    output_language: string | null;
    instructions: string | null;
  };
  prompt_name: string | null;
  video: VideoPreview | null;
}

interface JobPart {
  part_id: string;
  title: string | null;
  number: number | null;
  status: PartStatus;
  phase: Phase | null;
  error: Message | null;
  output_path: string | null;
  output_directory: string | null;
}

interface JobSnapshot {
  job_id: string;
  title: string;
  mode: "document" | "transcript";
  status: TaskStatus;
  phase: Phase | null;
  error: Message | null;
  can_restore: boolean;
  parts: JobPart[];
}

export interface TaskPart {
  readonly id: string;
  readonly title?: string;
  readonly number?: number;
  readonly status: PartStatus;
  readonly phase?: Phase;
  readonly error?: Message;
  readonly outputPath?: string;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly mode: JobSnapshot["mode"];
  readonly status: TaskStatus;
  readonly phase?: Phase;
  readonly error?: Message;
  readonly parts: readonly TaskPart[];
  readonly outputs: readonly string[];
  readonly outputDirectory?: string;
  readonly recovery: readonly TaskRecovery[];
  readonly canRestore: boolean;
}

const modelSettingErrors = new Set<MessageKey>([
  "mcp.asrSettings",
  "mcp.llmSettings",
  "error.loadModelSettings",
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

function recoveryFor(
  error: Message | null,
  phase: Phase | null,
): TaskRecovery | undefined {
  if (!error) return;
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

function presentTask(job: JobSnapshot): Task {
  const outputs: string[] = [];
  const folders = new Set<string>();
  const recovery = new Set<TaskRecovery>();
  function addRecovery(error: Message | null, phase: Phase | null) {
    const action = recoveryFor(error, phase);
    if (action) recovery.add(action);
  }

  addRecovery(job.error, job.phase);
  const parts = job.parts.map((part): TaskPart => {
    if (part.output_path) outputs.push(part.output_path);
    if (part.output_directory) folders.add(part.output_directory);
    if (part.status === "failed") addRecovery(part.error, part.phase);
    return {
      id: part.part_id,
      title: part.title ?? undefined,
      number: part.number ?? undefined,
      status: part.status,
      phase: part.phase ?? undefined,
      error: part.error ?? undefined,
      outputPath: part.output_path ?? undefined,
    };
  });
  return {
    id: job.job_id,
    title: job.title,
    mode: job.mode,
    status: job.status,
    phase: job.phase ?? undefined,
    error: job.error ?? undefined,
    parts,
    outputs,
    outputDirectory:
      folders.size === 1 ? folders.values().next().value : undefined,
    recovery: isUnfinished(job.status) ? [] : [...recovery],
    canRestore: job.can_restore,
  };
}

export function isUnfinished(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function revealOutput(
  path: string,
  isDirectory: boolean,
): Promise<void> {
  return invoke("reveal_output", { path, isDirectory });
}

export class TaskQueue {
  #listeners = new Set<() => void>();
  #snapshot: readonly Task[] = [];
  #connected = false;
  #refreshing = false;
  #refreshRequested = false;

  getSnapshot = (): readonly Task[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (!this.#connected && isTauri()) {
      this.#connected = true;
      void listen("tasks-changed", this.refresh)
        .then(this.refresh)
        .catch((error) => {
          this.#connected = false;
          console.error(error);
        });
    }
    return () => this.#listeners.delete(listener);
  };

  private refresh = async (): Promise<void> => {
    this.#refreshRequested = true;
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      while (this.#refreshRequested) {
        this.#refreshRequested = false;
        const jobs = await invoke<JobSnapshot[]>("list_tasks");
        this.#snapshot = jobs.map(presentTask);
        this.#listeners.forEach((listener) => listener());
      }
    } catch (error) {
      console.error(error);
    } finally {
      this.#refreshing = false;
    }
  };

  getRequest(jobId: string): Promise<TaskDraft> {
    return invoke("get_task_draft", { jobId });
  }

  enqueue(request: TaskRequest, promptName?: string): Promise<string> {
    return invoke("submit_task", { request, promptName });
  }

  cancelPart(jobId: string, partId: string): Promise<void> {
    return invoke("cancel_task", { jobId, partIds: [partId] });
  }

  remove(jobId?: string): Promise<void> {
    return invoke("remove_tasks", { jobId });
  }

  retry(
    jobId: string,
    options?: { partId?: string; outputDirectory?: string },
  ): Promise<boolean> {
    return invoke("retry_task", { jobId, ...options });
  }
}
