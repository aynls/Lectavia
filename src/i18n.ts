import i18next, { type TFunction } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import ja from "./locales/ja";
import zhCN from "./locales/zh-CN";

export const languages = {
  "zh-CN": "简体中文",
  ja: "日本語",
  en: "English",
} as const;

export type Locale = keyof typeof languages;
export type MessageKey = keyof typeof zhCN;
export type Message = {
  key: MessageKey;
  values?: Record<string, string | number | Message>;
};

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof zhCN };
    keySeparator: false;
  }
}

const defaultLocale = "zh-CN";
const storageKey = "lectavia.language";
const i18n = i18next.createInstance();

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(languages, value);
}

function savedLocale(): Locale {
  try {
    const locale = localStorage.getItem(storageKey);
    if (isLocale(locale)) return locale;
  } catch {
    // Language switching still works without storage.
  }
  return defaultLocale;
}

export function currentLocale(): Locale {
  const locale = i18n.resolvedLanguage;
  return isLocale(locale) ? locale : defaultLocale;
}

export async function changeLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try {
    localStorage.setItem(storageKey, locale);
  } catch {
    // Keep the language for this session.
  }
}

i18n.on("languageChanged", (locale) => {
  document.documentElement.lang = locale;
});

void i18n.use(initReactI18next).init({
  lng: savedLocale(),
  fallbackLng: defaultLocale,
  supportedLngs: Object.keys(languages),
  keySeparator: false,
  interpolation: { escapeValue: false, skipOnVariables: true },
  resources: {
    "zh-CN": { translation: zhCN },
    ja: { translation: ja },
    en: { translation: en },
  },
});

export function translator(locale: Locale): TFunction {
  return i18n.getFixedT(locale);
}

export function message(key: MessageKey, values?: Message["values"]): Message {
  return { key, values };
}

function isMessage(value: unknown): value is Message {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    Object.hasOwn(zhCN, value.key)
  );
}

export function errorMessage(
  error: unknown,
  fallback: MessageKey = "error.unexpected",
): Message {
  if (isMessage(error)) return error;
  const detail = error instanceof Error ? error.message : error;
  return typeof detail === "string" && detail.trim()
    ? message("error.external", { detail })
    : message(fallback);
}

export function redactMessage(
  text: Message,
  secrets: readonly string[],
): Message {
  if (!text.values) return text;
  const values = Object.fromEntries(
    Object.entries(text.values).map(([name, value]) => [
      name,
      isMessage(value)
        ? redactMessage(value, secrets)
        : typeof value === "string"
          ? secrets.reduce(
              (detail, secret) =>
                secret ? detail.replaceAll(secret, "•••") : detail,
              value,
            )
          : value,
    ]),
  );
  return { ...text, values };
}

export function renderMessage(t: TFunction, text: Message): string {
  const values = Object.fromEntries(
    Object.entries(text.values ?? {}).map(([name, value]) => [
      name,
      isMessage(value) ? renderMessage(t, value) : value,
    ]),
  );
  return t(text.key, { replace: values });
}
