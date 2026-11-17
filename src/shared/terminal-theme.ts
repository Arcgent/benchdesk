// Classic = the Rustig `--term-*` tokens (src/ui/rustig/tokens.css): background --term-bg, foreground
// --term-fg, brightBlack --term-muted, cursor --accent, neutral selection. This file is the single source for
// xterm AND the OSC 10/11 replies; keep it in step with tokens.css (pinned in tests/terminal-colors.test.ts).
export const terminalThemes = {
  dark: {
    background: "#1a1a1a",
    foreground: "#ffffff",
    cursor: "#4cc27a",
    selectionBackground: "#ffffff30",
    black: "#242424",
    red: "#e78b96",
    green: "#9edc9c",
    yellow: "#e7c78a",
    blue: "#83aaff",
    magenta: "#cba6ec",
    cyan: "#68c9c5",
    white: "#ffffff",
    brightBlack: "#9a9a94",
    brightRed: "#ff9baa",
    brightGreen: "#b0efac",
    brightYellow: "#f5dda4",
    brightBlue: "#a8c4ff",
    brightMagenta: "#dec1ff",
    brightCyan: "#8bded9",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#fafafa",
    foreground: "#2b2b2b",
    cursor: "#1f8a4c",
    selectionBackground: "#0d0d0d24",
    black: "#262626",
    red: "#b52d44",
    green: "#28783a",
    yellow: "#946511",
    blue: "#3262b8",
    magenta: "#8c45a8",
    cyan: "#187c82",
    white: "#65655f",
    brightBlack: "#6f6f6f",
    brightRed: "#c13750",
    brightGreen: "#258340",
    brightYellow: "#9b6d17",
    brightBlue: "#3b69c2",
    brightMagenta: "#9854b1",
    brightCyan: "#19878d",
    brightWhite: "#333330",
  },
};
export type TerminalThemeName = keyof typeof terminalThemes;
export type TerminalPreset = "classic" | "refined" | "compact";
type TerminalPalette = {
  [Key in keyof (typeof terminalThemes)["light"]]: string;
};

const terminalPresetColors: Record<
  Exclude<TerminalPreset, "classic">,
  Record<TerminalThemeName, Partial<TerminalPalette>>
> = {
  refined: {
    light: {
      background: "#fafbf7",
      foreground: "#30372b",
      cursor: "#57783e",
      selectionBackground: "#e4ecd9",
    },
    dark: {
      background: "#1b2018",
      foreground: "#ffffff",
      cursor: "#b3d58d",
      selectionBackground: "#3a472d",
    },
  },
  compact: {
    light: {
      background: "#fafafa",
      foreground: "#303233",
      cursor: "#576b69",
      selectionBackground: "#e1e8e6",
    },
    dark: {
      background: "#191c1d",
      foreground: "#ffffff",
      cursor: "#91bcb6",
      selectionBackground: "#314140",
    },
  },
};

export function terminalTheme(
  preset: TerminalPreset,
  theme: TerminalThemeName,
) {
  return preset === "classic"
    ? terminalThemes[theme]
    : { ...terminalThemes[theme], ...terminalPresetColors[preset][theme] };
}
