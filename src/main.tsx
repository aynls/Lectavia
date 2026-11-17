import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { message, type Message } from "./i18n";
import type { ModelSettingsValue } from "./ModelSettings";

async function start() {
  let settings: ModelSettingsValue | null = null;
  let settingsError: Message | undefined;
  if (isTauri()) {
    try {
      settings = await invoke<ModelSettingsValue | null>("load_model_settings");
    } catch {
      settingsError = message("error.loadModelSettings");
    }
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialSettings={settings} settingsError={settingsError} />
    </StrictMode>,
  );
}

void start();
