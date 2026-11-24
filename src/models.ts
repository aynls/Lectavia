import { invoke } from "@tauri-apps/api/core";
import { message, type Message } from "./i18n";

export interface ModelConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  catalogUrl?: string;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  defaultEffort?: string;
}

export type ModelPurpose = "asr" | "llm";
export type ModelConnectionField =
  "baseUrl" | "apiKey" | "model" | "catalogUrl";
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

export const OPENROUTER_ASR_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";
export const OPENROUTER_LLM_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_ASR_MODEL = "openai/whisper-large-v3-turbo";

function apiUrlField(value: string): string | Message {
  const input = value.trim();
  const url = URL.parse(input);
  const isLocal =
    url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (
    !url ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return message("error.baseUrl");
  }

  return input;
}

function modelField(value: string): string | Message {
  return value.trim() || message("error.modelId");
}

function requireValidField(value: string | Message): string {
  if (typeof value !== "string") throw value;
  return value;
}

export function validateModelConnection(
  connection: ModelConnection,
): ModelConnectionErrors {
  const baseUrl = apiUrlField(connection.baseUrl);
  const catalogUrl = connection.catalogUrl?.trim()
    ? apiUrlField(connection.catalogUrl)
    : "";
  const model = modelField(connection.model);
  return {
    baseUrl: typeof baseUrl === "string" ? undefined : baseUrl,
    apiKey: connection.apiKey.trim() ? undefined : message("error.apiKey"),
    model: typeof model === "string" ? undefined : model,
    catalogUrl: typeof catalogUrl === "string" ? undefined : catalogUrl,
  };
}

export async function listModels(
  catalogUrl: string,
  apiKey: string,
  purpose: ModelPurpose,
): Promise<CatalogModel[]> {
  const result = await invoke<{ data?: CatalogEntry[] }>("list_models", {
    url: requireValidField(apiUrlField(catalogUrl)),
    apiKey: requireValidField(apiKey.trim() || message("error.apiKey")),
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
