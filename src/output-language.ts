export const outputLanguages = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt",
  "it",
  "ru",
  "ar",
  "th",
  "vi",
  "id",
] as const;

export type OutputLanguage = (typeof outputLanguages)[number];
