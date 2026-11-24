import { invoke } from "@tauri-apps/api/core";
import asrPresets from "./asr-providers.json";
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

export type AsrProvider = keyof typeof asrPresets | "custom";
export interface AsrConnection extends ModelConnection {
  provider?: AsrProvider;
}

export { asrPresets };

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
  active?: boolean;
  reasoning?: { supported_efforts?: unknown; default_effort?: unknown };
}

export const OPENROUTER_LLM_URL =
  "https://openrouter.ai/api/v1/chat/completions";

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
  asrProvider?: AsrProvider,
): Promise<CatalogModel[]> {
  const result = await invoke<{ data?: CatalogEntry[] }>("list_models", {
    url: requireValidField(apiUrlField(catalogUrl)),
    apiKey: requireValidField(apiKey.trim() || message("error.apiKey")),
    asrProvider: asrProvider ?? null,
  });

  if (!Array.isArray(result?.data)) {
    throw message("error.catalogFormat");
  }

  const models = new Map<string, CatalogModel>();
  // These two APIs return general model catalogs without an ASR capability field.
  const generalCatalog = asrProvider === "openai" || asrProvider === "groq";
  for (const model of result.data) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (
      generalCatalog &&
      (model?.active === false ||
        !/(whisper|transcrib|transcript|speech[-_]to[-_]text)/i.test(id))
    )
      continue;
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
