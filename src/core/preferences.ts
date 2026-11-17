import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountInput,
  profileInput,
  type AssistantAccount,
  type Preferences,
} from "../shared/types";

const storedAccount = accountInput.extend({
  id: z.string(),
  email: z.string().default(""),
  status: z
    .enum(["logged_in", "logged_out", "expired", "unknown"])
    .default("unknown"),
  checkedAt: z.string().default(""),
});
const schema = z.object({
  profile: profileInput,
  accounts: z.array(storedAccount).max(100),
});

export function configPath(input: string) {
  const path =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? join(homedir(), input.slice(2))
        : input;
  if (!isAbsolute(path))
    throw new Error("Gebruik een absoluut pad of een pad dat met ~/ begint.");
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...missing);
}

// Only labels, preferences and configuration paths live here. Credentials remain
// under control of the provider CLI (including its native credential store).
export class PreferenceStore {
  value: Preferences;
  constructor(readonly path: string) {
    if (existsSync(path))
      this.value = schema.parse(JSON.parse(readFileSync(path, "utf8")));
    else
      this.value = {
        profile: profileInput.parse({}),
        accounts: (["claude", "codex"] as const).map((provider) => ({
          id: `default-${provider}`,
          provider,
          label: "Persoonlijk",
          configDir: configPath(join(homedir(), `.${provider}`)),
          companyIds: [],
          globalDefault: true,
          status: "unknown",
          email: "",
          checkedAt: "",
        })),
      };
  }
  persist() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + ".tmp", JSON.stringify(this.value, null, 2), {
      mode: 0o600,
    });
    renameSync(this.path + ".tmp", this.path);
  }
  profile(input: unknown) {
    this.value.profile = profileInput.parse(input);
    this.persist();
    return this.value.profile;
  }
  account(id: string) {
    const account = this.value.accounts.find((a) => a.id === id);
    if (!account)
      throw new Error("Account niet gevonden. Kies een beschikbaar account.");
    return account;
  }
  save(input: unknown, id?: string) {
    const value = accountInput.parse(input);
    value.configDir = configPath(value.configDir);
    if (id) {
      const old = this.account(id);
      if (
        old.provider !== value.provider ||
        configPath(old.configDir) !== value.configDir
      )
        throw new Error(
          "Voeg een nieuw account toe om een andere configuratiemap te gebruiken.",
        );
    }
    if (
      this.value.accounts.some(
        (a) =>
          a.id !== id &&
          a.provider === value.provider &&
          configPath(a.configDir) === value.configDir,
      )
    )
      throw new Error("Deze configuratiemap is al gekoppeld aan een account.");
    const row: AssistantAccount = {
      ...(id
        ? this.account(id)
        : {
            id: randomUUID(),
            status: "unknown" as const,
            email: "",
            checkedAt: "",
          }),
      ...value,
    };
    this.value.accounts = this.value.accounts
      .filter((a) => a.id !== row.id)
      .map((a) =>
        a.provider === row.provider
          ? {
              ...a,
              companyIds: a.companyIds.filter(
                (c) => !row.companyIds.includes(c),
              ),
              globalDefault: row.globalDefault ? false : a.globalDefault,
            }
          : a,
      )
      .concat(row);
    this.persist();
    return row.id;
  }
  remove(id: string) {
    this.account(id);
    this.value.accounts = this.value.accounts.filter((a) => a.id !== id);
    this.persist();
  }
  resolve(provider: string, companyId: string, accountId?: string | null) {
    if (provider === "shell") return null;
    const account = accountId
      ? this.account(accountId)
      : this.value.accounts.find(
          (a) => a.provider === provider && a.companyIds.includes(companyId),
        ) ||
        this.value.accounts.find(
          (a) => a.provider === provider && a.globalDefault,
        );
    if (account && account.provider !== provider)
      throw new Error("Dit account hoort bij een andere assistent.");
    return account || null;
  }
  setStatus(id: string, status: AssistantAccount["status"], email?: string) {
    const account = this.account(id);
    account.status = status;
    account.checkedAt = new Date().toISOString();
    if (email !== undefined) account.email = email;
    this.persist();
  }
}
