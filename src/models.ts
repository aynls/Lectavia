import { invoke } from "@tauri-apps/api/core";
import { message, translator, type Locale, type Message } from "./i18n";
import type { OutputLanguage } from "./output-language";

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

interface OrganizationOptions {
  connection: ModelConnection;
  locale: Locale;
  outputLanguage: OutputLanguage;
  videoTitle: string;
  partTitle?: string;
  description?: string;
  format: "md" | "txt";
  instructions?: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_ASR_MODEL = "openai/whisper-large-v3-turbo";

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

export function transcribeAudio(
  files: string[],
  connection: ModelConnection,
): Promise<string> {
  return invoke("transcribe_audio", {
    files,
    connection: normalizeConnection(connection),
  });
}

export function organizeTranscript(
  transcript: string,
  { connection, ...options }: OrganizationOptions,
): Promise<string> {
  return invoke("organize_transcript", {
    transcript,
    options: {
      ...options,
      outputLanguage: translator(options.locale)(
        `outputLanguage.${options.outputLanguage}`,
      ),
    },
    connection: { ...connection, ...normalizeConnection(connection) },
  });
}
