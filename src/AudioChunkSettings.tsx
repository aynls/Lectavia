import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, message, renderMessage, type Message } from "./i18n";

export function AudioChunkSettings() {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [seconds, setSeconds] = useState("");
  const [phase, setPhase] = useState<"loading" | "saving" | "idle">("loading");
  const [feedback, setFeedback] = useState<Message>();
  const saved = feedback?.key === "settings.savedAudioChunkSeconds";
  const invalid = feedback?.key === "settings.invalidAudioChunkSeconds";

  useEffect(() => {
    let current = true;
    invoke<string>("load_audio_chunk_seconds")
      .then((value) => {
        if (current) setSeconds(value);
      })
      .catch((error: unknown) => {
        if (current)
          setFeedback(errorMessage(error, "error.loadAudioChunkSeconds"));
      })
      .finally(() => {
        if (current) setPhase("idle");
      });
    return () => {
      current = false;
    };
  }, []);

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "idle") return;
    setPhase("saving");
    setFeedback(undefined);
    try {
      const value = await invoke<string>("save_audio_chunk_seconds", {
        seconds,
      });
      setSeconds(value);
      setFeedback(message("settings.savedAudioChunkSeconds"));
    } catch (error) {
      const failure = errorMessage(error, "error.saveAudioChunkSeconds");
      setFeedback(failure);
      if (failure.key === "settings.invalidAudioChunkSeconds") {
        input.current?.focus();
      }
    } finally {
      setPhase("idle");
    }
  }

  return (
    <form
      className="settings-row"
      aria-labelledby="audio-chunk-seconds-label"
      onSubmit={(event) => void save(event)}
    >
      <div className="settings-row-copy">
        <label htmlFor="audio-chunk-seconds" id="audio-chunk-seconds-label">
          {t("settings.audioChunkSeconds")}
        </label>
        <p id="audio-chunk-seconds-hint" className="muted">
          {t("settings.audioChunkSecondsHint")}
        </p>
      </div>
      <div className="settings-row-controls">
        <input
          id="audio-chunk-seconds"
          name="audio-chunk-seconds"
          ref={input}
          type="text"
          inputMode="numeric"
          value={seconds}
          disabled={phase === "loading"}
          readOnly={phase === "saving"}
          aria-invalid={invalid || undefined}
          aria-describedby={
            invalid
              ? "audio-chunk-seconds-hint audio-chunk-seconds-feedback"
              : "audio-chunk-seconds-hint"
          }
          onChange={(event) => {
            setSeconds(event.target.value);
            setFeedback(undefined);
          }}
        />
        <button type="submit" disabled={phase !== "idle"}>
          {t("settings.save")}
        </button>
      </div>
      {feedback && (
        <p
          id="audio-chunk-seconds-feedback"
          className={`settings-row-feedback ${saved ? "muted" : "error"}`}
          role={saved ? "status" : "alert"}
        >
          {renderMessage(t, feedback)}
        </p>
      )}
    </form>
  );
}
