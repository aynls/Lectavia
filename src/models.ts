import { invoke } from "@tauri-apps/api/core";
import {
  errorMessage,
  message,
  translator,
  type Locale,
  type Message,
} from "./i18n";

interface ModelEndpoint {
  baseUrl: string;
  apiKey: string;
}

export interface ModelConnection extends ModelEndpoint {
  model: string;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  defaultEffort?: string;
}

export type ModelPurpose = "asr" | "llm";
export type ModelConnectionField = keyof ModelEndpoint | "model";
export type ModelConnectionErrors = Partial<
  Record<ModelConnectionField, Message>
>;

export interface CatalogModel {
  id: string;
  name: string;
  reasoningEfforts?: string[];
  defaultEffort?: string;
}

interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  reasoning?: { supported_efforts?: unknown; default_effort?: unknown };
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OrganizationOptions {
  connection: ModelConnection;
  locale: Locale;
  title: string;
  format: "md" | "txt";
  instructions?: string;
}

interface ChatCompletion {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_ASR_MODEL = "openai/whisper-large-v3-turbo";

const SECTION_SIZE = 5_000;

function baseUrlField(value: string): string | Message {
  const baseUrl = URL.parse(value.trim());
  const isLocal =
    baseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);

  if (
    !baseUrl ||
    (baseUrl.protocol !== "https:" &&
      !(baseUrl.protocol === "http:" && isLocal)) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    return message("error.baseUrl");
  }

  const path = baseUrl.pathname.replace(/\/+$/, "");
  if (
    ["/models", "/audio/transcriptions", "/chat/completions"].some((route) =>
      path.endsWith(route),
    )
  ) {
    return message("error.baseUrlHasRoute");
  }

  return baseUrl.href.replace(/\/+$/, "");
}

function endpointFields(connection: ModelEndpoint) {
  return {
    baseUrl: baseUrlField(connection.baseUrl),
    apiKey: connection.apiKey.trim() || message("error.apiKey"),
  };
}

function modelField(value: string): string | Message {
  return value.trim() || message("error.modelId");
}

function requireValidField(value: string | Message): string {
  if (typeof value !== "string") throw value;
  return value;
}

function normalizeEndpoint(connection: ModelEndpoint): ModelEndpoint {
  const { baseUrl, apiKey } = endpointFields(connection);
  return {
    baseUrl: requireValidField(baseUrl),
    apiKey: requireValidField(apiKey),
  };
}

function normalizeConnection(connection: ModelConnection): ModelConnection {
  return {
    ...normalizeEndpoint(connection),
    model: requireValidField(modelField(connection.model)),
  };
}

export function validateModelConnection(
  connection: ModelConnection,
): ModelConnectionErrors {
  const { baseUrl, apiKey } = endpointFields(connection);
  const model = modelField(connection.model);
  return {
    baseUrl: typeof baseUrl === "string" ? undefined : baseUrl,
    apiKey: typeof apiKey === "string" ? undefined : apiKey,
    model: typeof model === "string" ? undefined : model,
  };
}

export async function listModels(
  connection: ModelEndpoint,
  purpose: ModelPurpose,
): Promise<CatalogModel[]> {
  const profile = normalizeEndpoint(connection);
  const host = new URL(profile.baseUrl).hostname;
  const transcription =
    purpose === "asr" && ["openrouter.ai", "eu.openrouter.ai"].includes(host);
  const result = await invoke<{ data?: CatalogEntry[] }>("list_models", {
    ...profile,
    transcription,
  });

  if (!Array.isArray(result?.data)) {
    throw message("error.catalogFormat");
  }

  const models = new Map<string, CatalogModel>();
  for (const model of result.data) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (id) {
      const name = typeof model.name === "string" ? model.name.trim() : "";
      const entry: CatalogModel = { id, name: name || id };
      const efforts = model.reasoning?.supported_efforts;
      if (purpose === "llm" && Array.isArray(efforts)) {
        entry.reasoningEfforts = [
          ...new Set(
            efforts.flatMap((effort: unknown) =>
              typeof effort === "string" && effort.trim()
                ? [effort.trim()]
                : [],
            ),
          ),
        ];
        const fallback = model.reasoning?.default_effort;
        if (
          typeof fallback === "string" &&
          entry.reasoningEfforts.includes(fallback)
        ) {
          entry.defaultEffort = fallback;
        }
      }
      models.set(id, entry);
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function transcribeAudio(
  files: string[],
  connection: ModelConnection,
): Promise<string> {
  const profile = normalizeConnection(connection);
  const transcripts: string[] = [];

  for (const [index, path] of files.entries()) {
    try {
      const result = await invoke<{ text?: unknown }>(
        "transcribe_audio_chunk",
        {
          ...profile,
          path,
        },
      );

      if (typeof result?.text !== "string") {
        throw message("error.transcriptionMissing");
      }

      const text = result.text.trim();
      if (text) {
        transcripts.push(text);
      }
    } catch (error) {
      throw message("error.transcriptionChunk", {
        number: index + 1,
        cause: errorMessage(error),
      });
    }
  }

  if (!transcripts.length) {
    throw message("error.noSpeech");
  }

  return transcripts.join("\n\n");
}

function splitTranscript(transcript: string): string[] {
  const sections: string[] = [];
  let start = 0;

  while (start < transcript.length) {
    let end = Math.min(start + SECTION_SIZE, transcript.length);
    if (end < transcript.length) {
      const candidate = transcript.slice(start, end);
      const sentenceEnd = Math.max(
        ...["\n", "。", "！", "？", "! ", "? ", ". "].map((separator) =>
          candidate.lastIndexOf(separator),
        ),
      );

      const boundary =
        sentenceEnd >= SECTION_SIZE / 2
          ? sentenceEnd
          : candidate.lastIndexOf(" ");
      if (boundary >= SECTION_SIZE / 2) {
        end = start + boundary + 1;
      } else {
        const last = transcript.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          end--;
        }
      }
    }

    const section = transcript.slice(start, end).trim();
    if (section) {
      sections.push(section);
    }

    start = end;
  }

  return sections;
}

function organizationPrompt(options: OrganizationOptions): string {
  const t = translator(options.locale);
  const prompt = [
    t("prompt.intro"),
    t("prompt.fidelity"),
    t("prompt.untrusted"),
    t("prompt.bodyOnly"),
    t(options.format === "md" ? "prompt.markdown" : "prompt.plainText"),
  ];

  const instructions = options.instructions?.trim();
  if (instructions) {
    prompt.push(t("prompt.custom"), instructions);
  }

  return prompt.join("\n\n");
}

export async function organizeTranscript(
  transcript: string,
  options: OrganizationOptions,
): Promise<string> {
  const profile = normalizeConnection(options.connection);
  const reasoningEffort = options.connection.reasoningEfforts?.includes(
    options.connection.reasoningEffort ?? "",
  )
    ? options.connection.reasoningEffort
    : undefined;
  const sections = splitTranscript(transcript);
  if (!sections.length) {
    throw message("error.emptyTranscript");
  }

  const systemPrompt = organizationPrompt(options);
  const material: string[] = [];

  for (const [index, section] of sections.entries()) {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          title: options.title,
          section: index + 1,
          sectionCount: sections.length,
          transcript: section,
        }),
      },
    ];
    const result = await invoke<ChatCompletion>("complete_text", {
      ...profile,
      messages,
      reasoningEffort,
    });
    const choice = result?.choices?.[0];

    if (choice?.finish_reason === "length") {
      throw message("error.outputLength");
    }
    if (
      choice?.finish_reason === "content_filter" ||
      choice?.message?.refusal
    ) {
      throw message("error.modelRefusal");
    }

    const content = choice?.message?.content;
    if (
      (choice?.finish_reason && choice.finish_reason !== "stop") ||
      typeof content !== "string" ||
      !content.trim()
    ) {
      throw message("error.modelEmpty");
    }

    material.push(content.trim());
  }

  return material.join("\n\n") + "\n";
}
