import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore, configPath } from "../src/core/preferences";
import { accountEnvironment, authArgs } from "../src/runtime/accounts";

test("accountkeuze per bedrijf, persoonlijke fallback en opgeslagen voorkeuren", (t) => {
  const root = mkdtempSync(join(tmpdir(), "werk-accounts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "preferences.json"),
    prefs = new PreferenceStore(path);
  const first = prefs.save({
    provider: "claude",
    label: "Bedrijf A",
    configDir: join(root, "claude-a"),
    companyIds: ["company-a"],
    globalDefault: false,
  });
  const second = prefs.save({
    provider: "claude",
    label: "Bedrijf B",
    configDir: join(root, "claude-b"),
    companyIds: ["company-b"],
  });
  assert.equal(prefs.resolve("claude", "company-a")?.id, first);
  assert.equal(prefs.resolve("claude", "company-b")?.id, second);
  assert.equal(prefs.resolve("claude", "company-a", second)?.id, second);
  assert.equal(prefs.resolve("codex", "company-a")?.id, "default-codex");
  assert.throws(
    () => prefs.resolve("codex", "company-a", first),
    /andere assistent/,
  );
  prefs.save(
    {
      provider: "claude",
      label: "Bedrijf B nieuw",
      configDir: join(root, "claude-b"),
      companyIds: ["company-a", "company-b"],
    },
    second,
  );
  assert.equal(prefs.resolve("claude", "company-a")?.id, second);
  assert.deepEqual(prefs.account(first).companyIds, []);
  prefs.profile({
    name: "Voorbeeldgebruiker",
    weekStart: 2,
    appearance: "dark",
    terminalPreset: "refined",
    terminalFont: "plex",
    terminalFontSize: 14,
    terminalLineHeight: 1.55,
  });
  const reopened = new PreferenceStore(path);
  assert.equal(reopened.value.profile.weekStart, 2);
  assert.equal(reopened.value.profile.name, "Voorbeeldgebruiker");
  assert.equal(reopened.value.profile.terminalPreset, "refined");
  assert.equal(reopened.value.profile.terminalFontSize, 14);
  assert.equal(
    reopened.resolve("claude", "company-a")?.label,
    "Bedrijf B nieuw",
  );
  assert.ok(!/access_token|password|apiKey/.test(readFileSync(path, "utf8")));
  assert.throws(
    () =>
      reopened.save({
        provider: "claude",
        label: "Duplicate",
        configDir: join(root, "claude-b"),
      }),
    /al gekoppeld/,
  );
  assert.throws(
    () =>
      reopened.save({
        provider: "claude",
        label: "Invalid",
        configDir: "relative-path",
      }),
    /absoluut/,
  );
  assert.deepEqual(accountEnvironment("claude", join(root, "claude-a")), {
    CLAUDE_CONFIG_DIR: join(root, "claude-a"),
  });
  assert.deepEqual(accountEnvironment("codex", join(root, "codex-a")), {
    CODEX_HOME: join(root, "codex-a"),
  });
  assert.deepEqual(authArgs("claude", "login"), ["auth", "login"]);
  assert.deepEqual(authArgs("codex", "status"), ["login", "status"]);
});

test("een accountmap via een symlink blijft na de eerste login bewerkbaar en kan niet dubbel worden gekoppeld", (t) => {
  const root = mkdtempSync(join(tmpdir(), "werk-account-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "alias"));
  const prefs = new PreferenceStore(join(root, "prefs.json"));
  const value = {
    provider: "claude",
    label: "Voor login",
    configDir: join(root, "alias", "new-account"),
  };
  const id = prefs.save(value);
  mkdirSync(value.configDir);
  prefs.save({ ...value, label: "Na login", companyIds: ["c"] }, id);
  assert.equal(prefs.account(id).configDir, configPath(value.configDir));
  assert.throws(
    () =>
      prefs.save({ ...value, configDir: join(root, "real", "new-account") }),
    /al gekoppeld/,
  );
});
