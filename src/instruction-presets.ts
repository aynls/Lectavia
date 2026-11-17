import type { PromptFile } from "./tasks";

export interface InstructionPreset {
  id: string;
  name: string;
  instructions: string;
  prompt: PromptFile | null;
}

const storageKey = "lectavia.instruction-presets.v1";

function isPromptFile(value: unknown): value is PromptFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "content" in value &&
    typeof value.content === "string"
  );
}

function isPreset(value: unknown): value is InstructionPreset {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "instructions" in value &&
    typeof value.instructions === "string" &&
    "prompt" in value &&
    (value.prompt === null || isPromptFile(value.prompt))
  );
}

export function loadInstructionPresets(): InstructionPreset[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    );
    return Array.isArray(stored) ? stored.filter(isPreset) : [];
  } catch {
    return [];
  }
}

export function storeInstructionPresets(presets: InstructionPreset[]): void {
  localStorage.setItem(storageKey, JSON.stringify(presets));
}
