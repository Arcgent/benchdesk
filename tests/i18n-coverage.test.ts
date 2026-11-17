import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import english from "../src/shared/locales/en.json";

// Every literal tr("…") / t("…") in src/ needs an English entry in src/shared/locales/en.json: a missing key
// falls back to Dutch silently, so nothing else would ever notice.
//
// STRICT = true since the Rustig integration merged the package fragments: a missing key fails the build.
// (It was false while packages collected their strings in tmp/rustig/i18n/<package>.json.)
const STRICT = true;

// Dutch source strings that are spelled the same in English do not need an entry. Keep this list short and literal.
const SAME_IN_ENGLISH = new Set<string>(["Check-ins", "Codex", "Claude Code"]);

const root = [process.cwd(), join(__dirname, "..", "..")].find((dir) =>
  existsSync(join(dir, "src/shared/locales/en.json")),
);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
        ? [join(dir, entry.name)]
        : [],
  );
}
// Full-line // comments and /* … */ blocks are not code: a quoted word in a comment is neither a usage nor a key.
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
// tr("…") and t("…") with a plain string as first argument, across line breaks. A call on another object
// (x.t(…)) or a longer identifier (format(…), split(…)) is not ours.
const call =
  /(?<![\w$.])(?:tr|t)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
function unquote(raw: string): string {
  const body = raw.slice(1, -1);
  try {
    return JSON.parse(
      `"${body
        .replace(/\\'/g, "'")
        .replace(/\\`/g, "`")
        .replace(/(?<!\\)"/g, '\\"')
        .replace(/\n/g, "\\n")}"`,
    );
  } catch {
    return body;
  }
}
function literal(raw: string): string | null {
  if (raw[0] === "`" && raw.includes("${")) return null; // interpolated: can never be a key
  return unquote(raw);
}
function scan(files: string[], base: string) {
  const used = new Map<string, string>(),
    dynamic: string[] = [];
  for (const file of files) {
    const text = code(file);
    for (const match of text.matchAll(call)) {
      const line = text.slice(0, match.index).split("\n").length,
        where = `${relative(base, file)}:${line}`,
        key = literal(match[1]);
      if (key === null) dynamic.push(where);
      else if (!used.has(key)) used.set(key, where);
    }
  }
  return { used, dynamic };
}

test("every literal UI string has an English translation", (t) => {
  assert.ok(root, "run the tests from the project root");
  const files = sources(join(root, "src"));
  assert.ok(files.length > 40, "the source scan found the UI");
  const { used, dynamic } = scan(files, root);
  assert.ok(
    used.size > 300,
    `the scan recognises tr("…") calls (found ${used.size})`,
  );
  assert.ok(used.has("Vandaag"), "a known key is found");
  const messages: Record<string, string> = english;
  const missing = [...used].filter(
    ([key]) => !Object.hasOwn(messages, key) && !SAME_IN_ENGLISH.has(key),
  );
  if (missing.length)
    t.diagnostic(
      `${missing.length} UI string(s) without an English translation${STRICT ? "" : " (report only, STRICT = false)"}:\n` +
        missing
          .map(([key, where]) => `  ${where}  ${JSON.stringify(key)}`)
          .join("\n"),
    );
  if (dynamic.length)
    t.diagnostic(
      `${dynamic.length} interpolated template literal(s) passed to tr(): these can never be translated:\n  ${dynamic.join("\n  ")}`,
    );
  if (STRICT) {
    assert.deepEqual(
      missing.map(([key]) => key),
      [],
      "add these keys to src/shared/locales/en.json",
    );
    assert.deepEqual(dynamic, [], "use {0} placeholders instead of ${…}");
  }
});

// Every string literal in src/ (any quote style, quoted strings inside ${…} included, the expression itself
// replaced by a marker): the pool that tr(variable), label tables and translateMessage draw their keys from.
const anyString =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const quoted = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
function literals(files: string[]) {
  const pool: string[] = [];
  for (const file of files)
    for (const match of code(file).matchAll(anyString)) {
      const raw = match[0];
      if (raw[0] !== "`") pool.push(unquote(raw));
      else {
        for (const inner of raw.matchAll(quoted)) pool.push(unquote(inner[0]));
        pool.push(
          unquote("`" + raw.slice(1, -1).replace(/\$\{[^}]*\}/g, "\0") + "`"),
        );
      }
    }
  return pool;
}
// The same template → regex rule translateMessage uses (src/shared/i18n.ts).
const messageRegex = (key: string) =>
  new RegExp(
    `^${key
      .split(/(\{\d+\})/)
      .map((part) =>
        /^\{\d+\}$/.test(part)
          ? "([\\s\\S]*?)"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
  );

test("report: English keys that nothing in src/ produces", (t) => {
  assert.ok(root, "run the tests from the project root");
  const files = sources(join(root, "src"));
  const { used } = scan(files, root);
  const pool = literals(files);
  const exact = new Set(pool);
  const templates = pool.filter((s) => s.includes("\0"));
  const messages: Record<string, string> = english;
  const unused = Object.keys(messages).filter((key) => {
    if (used.has(key) || exact.has(key)) return false;
    if (!/\{\d+\}/.test(key)) return true;
    const regex = messageRegex(key);
    return !templates.some((s) => regex.test(s));
  });
  // Report only: a key here is either dead or built by concatenation (e.g. "Wekelijks · volgende {0}" in
  // src/shared/task-schedule.ts, which tests/i18n.test.ts pins). Remove the dead ones by hand, never blindly.
  t.diagnostic(
    `${unused.length} key(s) in en.json that no tr() literal, label table or message template in src/ produces (report only):\n  ${unused
      .map((key) => JSON.stringify(key))
      .join("\n  ")}`,
  );
});

test("the string scanner reads the call shapes the code base uses", () => {
  const probe = [
    'tr("Gewoon")',
    'tr(\n  "Over twee regels {0}",\n  value,\n)',
    "t('Enkele quotes')",
    'tr("Met \\"aanhalingstekens\\" erin")',
    "tr(`Backticks zonder waarde`)",
    "tr(`Met ${waarde}`)",
    'format("Niet van ons")',
    'object.t("Ook niet")',
    "tr(labels[status])",
  ].join(";\n");
  const found = [...probe.matchAll(call)].map((m) => literal(m[1]));
  assert.deepEqual(found, [
    "Gewoon",
    "Over twee regels {0}",
    "Enkele quotes",
    'Met "aanhalingstekens" erin',
    "Backticks zonder waarde",
    null,
  ]);
  assert.equal(
    messageRegex("Gepland · {0}").test("Gepland · \0"),
    true,
    "a template literal with an expression matches its message key",
  );
});
