import {
  terminalTheme,
  type TerminalPreset,
  type TerminalThemeName,
} from "../shared/terminal-theme";

// Reply before the renderer has mounted a terminal. The CLI probes once at
// startup; serializing a headless screen loses the original OSC query.
// Keep parsing state per PTY because an OSC can straddle output events.
export class TerminalColors {
  theme: TerminalThemeName = "light";
  preset: TerminalPreset = "classic";
  private pending = new Map<string, { data: string; at: number }>();
  push(id: string, chunk: string): string {
    const previous = this.pending.get(id);
    const data =
      (previous && Date.now() - previous.at < 1000 ? previous.data : "") +
      chunk;
    this.pending.delete(id);
    let reply = "",
      offset = 0;
    const osc = /(?:\x1b\]|\x9d)([^\x07\x1b\x9c]*)(?:\x07|\x1b\\|\x9c)/g;
    for (const match of data.matchAll(osc)) {
      offset = match.index! + match[0].length;
      const parts = match[1].split(";");
      const command = Number(parts.shift());
      if (command !== 10 && command !== 11) continue;
      for (let i = 0; i < parts.length; i++) {
        const slot = command + i;
        if (parts[i] !== "?" || (slot !== 10 && slot !== 11)) continue;
        const color =
          terminalTheme(this.preset, this.theme)[
            slot === 10 ? "foreground" : "background"
          ];
        const rgb = color
          .slice(1)
          .match(/../g)!
          .map((pair) => pair + pair)
          .join("/");
        reply += `\x1b]${slot};rgb:${rgb}\x1b\\`;
      }
    }
    // Retain only a possible incomplete escape sequence, never whole logs.
    const tail = data.slice(offset);
    const start = Math.max(tail.lastIndexOf("\x1b]"), tail.lastIndexOf("\x9d"));
    const partial =
      start >= 0 ? tail.slice(start) : tail.endsWith("\x1b") ? "\x1b" : "";
    if (partial && partial.length < 128)
      this.pending.set(id, { data: partial, at: Date.now() });
    if (this.pending.size > 100) {
      for (const [key, item] of this.pending)
        if (Date.now() - item.at >= 1000) this.pending.delete(key);
      if (this.pending.size > 100)
        this.pending.delete(this.pending.keys().next().value!);
    }
    return reply;
  }
}
