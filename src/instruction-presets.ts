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

export function saveInstructionPreset(
  instructions: string,
  prompt: PromptFile | null,
): { presets: InstructionPreset[]; selectedId: string } {
  const presets = loadInstructionPresets();
  const text = prompt ? "" : instructions.trim();
  const existing = presets.find((preset) =>
    prompt
      ? preset.prompt?.name === prompt.name &&
        preset.prompt.content === prompt.content
      : !preset.prompt && preset.instructions === text,
  );
  if (existing) return { presets, selectedId: existing.id };

  const firstLine = prompt?.name ?? text.split(/\r?\n/, 1)[0];
  const characters = Array.from(firstLine);
  const baseName =
    characters.length > 48 ? `${characters.slice(0, 47).join("")}…` : firstLine;
  const names = new Set(presets.map((preset) => preset.name));
  let name = baseName;
  for (let index = 2; names.has(name); index += 1) {
    name = `${baseName} (${index})`;
  }

  const preset = { id: crypto.randomUUID(), name, instructions: text, prompt };
  const next = [...presets, preset];
  localStorage.setItem(storageKey, JSON.stringify(next));
  return { presets: next, selectedId: preset.id };
}
