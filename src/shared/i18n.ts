import english from "./locales/en.json";

export type Language = "nl" | "en";
let language: Language = "nl";
const messages: Record<string, string> = english;
export const getLanguage = () => language;
export const setLanguage = (value: Language) => {
  language = value;
};
export const locale = () => (language === "en" ? "en-GB" : "nl-NL");

// Only application-owned strings go through t. User content and terminal output
// are rendered directly; interpolation values are never translated or executed.
export function t(source: string, ...values: unknown[]): string {
  const text = language === "en" ? (messages[source] ?? source) : source;
  return values.length
    ? text.replace(/\{(\d+)\}/g, (token, index) =>
        Number(index) < values.length
          ? String(values[Number(index)] ?? "")
          : token,
      )
    : text;
}

// Legacy services return human-readable messages. Match known message templates
// at the UI boundary without changing stored data or provider output.
const patterns = Object.keys(messages)
  .filter((key) => /\{\d+\}/.test(key))
  .sort(
    (a, b) =>
      b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length,
  )
  .map((key) => {
    const slots: number[] = [];
    const pattern = key
      .split(/(\{\d+\})/)
      .map((part) => {
        if (/^\{\d+\}$/.test(part)) {
          slots.push(Number(part.slice(1, -1)));
          return "([\\s\\S]*?)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return { key, slots, regex: new RegExp(`^${pattern}$`) };
  });
export function translateMessage(source: string): string {
  if (language !== "en" || !source) return source;
  if (Object.hasOwn(messages, source)) return t(source);
  for (const { key, slots, regex } of patterns) {
    const match = source.match(regex);
    if (!match) continue;
    const values: string[] = [];
    slots.forEach((slot, index) => {
      values[slot] = match[index + 1];
    });
    return t(key, ...values);
  }
  return source;
}
