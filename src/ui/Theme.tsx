import { t as tr } from "../shared/i18n";
import { useEffect, useState } from "react";
import { api, useWorkbench } from "./model";
import { Moon, Sun } from "lucide-react";
import { profileInput, type UserProfile } from "../shared/types";
import { IconButton } from "./rz";
import lightLogo from "./assets/benchdesk-logo-light.png";
import darkLogo from "./assets/benchdesk-logo-dark.png";
const terminalSettingsKey = "benchdesk-terminal-settings";

export function storeTerminalPreferences(profile: UserProfile) {
  localStorage.setItem(
    terminalSettingsKey,
    JSON.stringify({
      terminalPreset: profile.terminalPreset,
      terminalFont: profile.terminalFont,
      terminalFontSize: profile.terminalFontSize,
      terminalLineHeight: profile.terminalLineHeight,
    }),
  );
  localStorage.setItem("benchdesk-terminal-preset", profile.terminalPreset);
}

export function mergeTerminalPreferences(profile: unknown): UserProfile {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(terminalSettingsKey) || "{}");
  } catch {}
  return profileInput.parse({ ...(profile as object), ...(stored as object) });
}

export function applyTheme(theme: string, terminalPreset?: string) {
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  // Available before a conversation opens; startup probes must not wait for xterm.
  void api("terminal.theme", {
    theme: theme === "dark" ? "dark" : "light",
    preset:
      terminalPreset ||
      localStorage.getItem("benchdesk-terminal-preset") ||
      "classic",
  }).catch(() => {});
}
// Design style, independent of light/dark: "shadcn" (default, after ui.shadcn.com/docs), "standaard" (Rustig)
// or "minimaal" (calmer, fewer frames and colour). Stored per device, applied as `data-design` on <html>; the
// shadcn and minimal rules live in rustig/shadcn.css and rustig/minimaal.css, each under
// `html:root[data-design="…"]`, so Rustig itself never changes. Nothing stored = the default.
export type Design = "shadcn" | "standaard" | "minimaal";
const designs: readonly Design[] = ["shadcn", "standaard", "minimaal"];
const designKey = "benchdesk-design";
export function storedDesign(): Design {
  try {
    const stored = localStorage.getItem(designKey) as Design | null;
    return stored && designs.includes(stored) ? stored : "shadcn";
  } catch {
    return "shadcn";
  }
}
export function applyDesign(design: Design) {
  document.documentElement.dataset.design = design;
}
export function setDesign(design: Design) {
  try {
    localStorage.setItem(designKey, design);
  } catch {}
  applyDesign(design);
  window.dispatchEvent(new Event(designKey));
}
export function useDesign() {
  const [design, set] = useState(storedDesign);
  useEffect(() => {
    const sync = () => set(storedDesign());
    window.addEventListener(designKey, sync);
    return () => window.removeEventListener(designKey, sync);
  }, []);
  return design;
}
const themeKey = "benchdesk-theme";
const storedTheme = () => localStorage.getItem(themeKey) || "light";
// One way to change the theme: store it, apply it, tell everyone who draws with it (xterm, the theme button).
export function setTheme(theme: string) {
  if (
    storedTheme() === theme &&
    document.documentElement.dataset.theme === theme
  )
    return;
  localStorage.setItem(themeKey, theme);
  applyTheme(theme);
  window.dispatchEvent(new Event(themeKey));
}
export function useTheme() {
  const [theme, set] = useState(storedTheme);
  useEffect(() => {
    const sync = () => set(storedTheme());
    window.addEventListener(themeKey, sync);
    return () => window.removeEventListener(themeKey, sync);
  }, []);
  return theme;
}
// Called ONCE, in App: the theme follows the profile (and the system, for "Systeem") wherever the button
// renders, or when no button is on screen at all. Pass null until the preferences are loaded, so the stored
// theme is not overwritten by the default profile on the first frame.
export function useThemeSync(appearance: UserProfile["appearance"] | null) {
  useEffect(() => {
    if (!appearance) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () =>
      setTheme(
        appearance === "system"
          ? media.matches
            ? "dark"
            : "light"
          : appearance,
      );
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [appearance]);
}
// Both files are rendered; shell.css shows the one that fits the theme, so the logo never flashes on a switch.
export function Brand() {
  return (
    <span className="rz-brand">
      <img className="rz-brand__light" src={lightLogo} alt="benchdesk.ai" />
      <img className="rz-brand__dark" src={darkLogo} alt="benchdesk.ai" />
    </span>
  );
}
// Quiet 30px icon button (decision D3). The accessible names are a test contract: "Donker thema" / "Licht thema".
export function ThemeSwitch({ className }: { className?: string }) {
  const { prefs, run, refreshPreferences } = useWorkbench();
  const theme = useTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <IconButton
      variant="side"
      className={className}
      label={theme === "light" ? tr("Donker thema") : tr("Licht thema")}
      onClick={() => {
        setTheme(next);
        void run(async () => {
          await api("profile.save", {
            value: { ...prefs.profile, appearance: next },
          });
          await refreshPreferences();
        });
      }}
    >
      {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </IconButton>
  );
}
