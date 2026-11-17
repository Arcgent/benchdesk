import { useSyncExternalStore } from "react";
import { getLanguage, setLanguage, t, type Language } from "../shared/i18n";

const storageKey = "benchdesk-language";
const listeners = new Set<() => void>();
// Appearance preferences belong to this installation/browser, independently of
// the terminal service. Switching language never restarts a running conversation.
function storedLanguage(): Language {
  try {
    return localStorage.getItem(storageKey) === "en" ? "en" : "nl";
  } catch {
    return "nl";
  }
}
setLanguage(storedLanguage());
document.documentElement.lang = getLanguage();
document.title = t("Benchdesk — ruimte voor wat telt");
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage);
}
export function changeLanguage(value: Language) {
  localStorage.setItem(storageKey, value);
  setLanguage(value);
  document.documentElement.lang = value;
  document.title = t("Benchdesk — ruimte voor wat telt");
  listeners.forEach((listener) => listener());
}
window.addEventListener("storage", (event) => {
  if (event.key === storageKey) {
    setLanguage(storedLanguage());
    document.documentElement.lang = getLanguage();
    document.title = t("Benchdesk — ruimte voor wat telt");
    listeners.forEach((listener) => listener());
  }
});
