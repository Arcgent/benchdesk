// Benchdesk provides an interactive true-color PTY. Do not inherit an agent's
// non-interactive log preferences (NO_COLOR or FORCE_COLOR=1) into its child CLI.
export function interactiveEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  env.CLICOLOR = "1";
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}
