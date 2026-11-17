import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TerminalColors } from "../src/core/terminal-colors";
import { interactiveEnvironment } from "../src/runtime/terminal-env";
import { terminalThemes } from "../src/shared/terminal-theme";

test("the classic terminal palette is the Rustig --term-* token set in both themes", () => {
  const css = readFileSync("src/ui/rustig/tokens.css", "utf8");
  const [light, dark] = css.split('\n:root[data-theme="dark"] {');
  assert.ok(light && dark);
  const token = (block: string, name: string) =>
    block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1];
  for (const [theme, block] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    assert.equal(terminalThemes[theme].background, token(block, "term-bg"));
    assert.equal(terminalThemes[theme].foreground, token(block, "term-fg"));
    assert.equal(terminalThemes[theme].brightBlack, token(block, "term-muted"));
    assert.equal(terminalThemes[theme].cursor, token(block, "accent"));
  }
  assert.equal(terminalThemes.light.background, "#fafafa");
  assert.equal(terminalThemes.light.foreground, "#2b2b2b");
  assert.equal(terminalThemes.dark.background, "#1a1a1a");
  assert.equal(terminalThemes.dark.foreground, "#ffffff");
});

test("startup color probes receive the selected palette before a renderer exists", () => {
  const colors = new TerminalColors();
  assert.equal(
    colors.push("one", "\x1b]10;?\x1b\\\x1b]11;?\x1b\\"),
    "\x1b]10;rgb:2b2b/2b2b/2b2b\x1b\\\x1b]11;rgb:fafa/fafa/fafa\x1b\\",
  );
  colors.theme = "dark";
  assert.equal(
    colors.push("one", "\x1b]10;?;?\x07"),
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:1a1a/1a1a/1a1a\x1b\\",
  );
  colors.preset = "refined";
  assert.equal(
    colors.push("refined", "\x1b]10;?\x1b\\\x1b]11;?\x1b\\"),
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:1b1b/2020/1818\x1b\\",
  );
});

test("the desktop initialises startup probes from its persisted theme", () => {
  const source = readFileSync("src/electron/main.ts", "utf8");
  const readTheme = source.indexOf('readFileSync(themePath, "utf8")');
  const initialiseColors = source.indexOf("terminalColors.theme =", readTheme);
  const connect = source.indexOf("async function connect", readTheme);
  assert.ok(readTheme >= 0);
  assert.ok(initialiseColors > readTheme);
  assert.ok(
    initialiseColors < connect,
    "the OSC responder must know the persisted theme before terminal events can connect",
  );
  assert.match(
    source.slice(initialiseColors, connect),
    /storedTheme\s*\?\?\s*\(nativeTheme\.shouldUseDarkColors/,
  );
});

test("every possible PTY chunk boundary preserves probes without crossing sessions", () => {
  const probe = "\x1b]10;?\x1b\\\x1b]11;?\x07";
  const expected = new TerminalColors().push("whole", probe);
  for (let i = 1; i < probe.length; i++) {
    const colors = new TerminalColors();
    const first = colors.push("one", probe.slice(0, i));
    assert.equal(colors.push("other", "unrelated text"), "");
    assert.equal(first + colors.push("one", probe.slice(i)), expected);
    assert.equal(colors.push("one", "more output"), "");
  }
  const colors = new TerminalColors();
  assert.equal(colors.push("one", "\x1b]11;"), "");
  assert.equal(colors.push("other", "?\x07"), "");
  assert.equal(colors.push("one", "?\x07"), "\x1b]11;rgb:fafa/fafa/fafa\x1b\\");
});

test("ordinary output, palette setters and unsupported OSCs never become input", () => {
  const colors = new TerminalColors();
  for (const output of [
    "hello",
    "\x1b[31mred\x1b[0m",
    "\x1b]0;title\x07",
    "\x1b]11;rgb:ff/00/00\x07",
    "\x1b]12;?\x07",
    "\x1b]52;c;?\x07",
    "\x1b]11;" + "x".repeat(1000),
  ])
    assert.equal(colors.push("one", output), "");
  assert.equal(colors.push("one", "?\x07"), "");
  assert.equal(
    colors.push("one", "\x9d11;?\x9c"),
    "\x1b]11;rgb:fafa/fafa/fafa\x1b\\",
  );
});

test("interactive child CLIs retain account settings but discard inherited color suppression", () => {
  const source = {
    NO_COLOR: "1",
    FORCE_COLOR: "1",
    CLICOLOR_FORCE: "1",
    TERM: "dumb",
    CODEX_HOME: "/test/account",
    PATH: "/test/bin",
  };
  const env = interactiveEnvironment(source);
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.CLICOLOR_FORCE, undefined);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.CLICOLOR, "1");
  assert.equal(env.CODEX_HOME, source.CODEX_HOME);
  assert.equal(env.PATH, source.PATH);
  assert.equal(source.NO_COLOR, "1");
});
