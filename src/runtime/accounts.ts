import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantAccount } from "../shared/types";
import { shellQuote } from "./adapters";

export const accountVariable = (provider: string) =>
  provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
export function accountEnvironment(provider: string, configDir: string) {
  if (!configDir || provider === "shell") return {};
  return { [accountVariable(provider)]: configDir };
}
export function authArgs(
  provider: string,
  action: "login" | "logout" | "status",
) {
  return provider === "claude"
    ? ["auth", action, ...(action === "status" ? ["--json"] : [])]
    : action === "status"
      ? ["login", "status"]
      : [action];
}
export function isolatedAccount(provider: string, configDir: string) {
  return !!configDir && configDir !== join(homedir(), `.${provider}`);
}
export function clearAccountOverrides(
  env: NodeJS.ProcessEnv,
  provider: string,
) {
  for (const key of provider === "claude"
    ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
    : ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])
    delete env[key];
}
export async function inspectAccount(
  account: AssistantAccount,
): Promise<{ status: AssistantAccount["status"]; email?: string }> {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    CLAUDECODE: undefined,
  };
  const unset = isolatedAccount(account.provider, account.configDir)
    ? account.provider === "claude"
      ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
      : ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
    : [];
  const command = [
    "env",
    ...unset.flatMap((key) => ["-u", key]),
    `${accountVariable(account.provider)}=${account.configDir}`,
    account.provider,
    ...authArgs(account.provider, "status"),
  ]
    .map(shellQuote)
    .join(" ");
  try {
    const { stdout } = await promisify(execFile)(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", command],
      { env, timeout: 10000, maxBuffer: 50000, cwd: homedir() },
    );
    if (account.provider === "claude") {
      const start = stdout.indexOf("{");
      const value = JSON.parse(stdout.slice(start));
      return {
        status: value.loggedIn
          ? "logged_in"
          : account.status === "logged_in"
            ? "expired"
            : "logged_out",
        email:
          typeof value.email === "string"
            ? value.email.slice(0, 250)
            : undefined,
      };
    }
    return { status: "logged_in" };
  } catch (error: any) {
    // Never forward CLI output: it can contain account identifiers or key hints.
    const output = String(error.stdout || "") + String(error.stderr || "");
    if (
      !error.killed &&
      (error.code === 1 || /not logged in|loggedIn["\s:]+false/i.test(output))
    )
      return {
        status: account.status === "logged_in" ? "expired" : "logged_out",
      };
    return { status: "unknown" };
  }
}
