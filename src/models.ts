import { invoke } from "@tauri-apps/api/core";
import { errorMessage, message, translator, type Locale } from "./i18n";

interface ModelEndpoint {
  baseUrl: string;
  apiKey: string;
}

export interface ModelConnection extends ModelEndpoint {
  model: string;
  reasoningEffort?: string;
}

export type ModelPurpose = "asr" | "llm";

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

function normalizeEndpoint(connection: ModelEndpoint): ModelEndpoint {
  const baseUrl = URL.parse(connection.baseUrl.trim());
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
    throw message("error.baseUrl");
  }

  const path = baseUrl.pathname.replace(/\/+$/, "");
  if (
    ["/models", "/audio/transcriptions", "/chat/completions"].some((route) =>
      path.endsWith(route),
    )
  ) {
    throw message("error.baseUrlHasRoute");
  }

  const apiKey = connection.apiKey.trim();
  if (!apiKey) {
    throw message("error.apiKey");
  }

  return { baseUrl: baseUrl.href.replace(/\/+$/, ""), apiKey };
}

function normalizeConnection(connection: ModelConnection): ModelConnection {
  const endpoint = normalizeEndpoint(connection);
  const model = connection.model.trim();
  if (!model) {
    throw message("error.modelId");
  }

  return { ...endpoint, model };
}

export function validateModelConnection(connection: ModelConnection): void {
  normalizeConnection(connection);
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
  const reasoningEffort =
    options.connection.reasoningEffort?.trim() || undefined;
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
