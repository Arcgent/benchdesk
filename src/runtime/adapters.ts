import { brainInstruction } from "../shared/brain";
import { memoryInstruction } from "../shared/memory";
import { join } from "node:path";
import type { Provider, Mode } from "../shared/types";
export const shellQuote = (text: string) =>
  "'" + text.replace(/'/g, "'\\''") + "'";
export const toml = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(toml).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`)
          .join(",")}}`
      : JSON.stringify(value);
export function adapterConfig(
  provider: Provider,
  runtimeDir: string,
  nodePath: string,
  resumeId?: string,
) {
  const helper = `ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodePath)} ${shellQuote(join(runtimeDir, "hook.cjs"))}`;
  const names = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ];
  const hooks = Object.fromEntries(
    names.map((name) => [
      name,
      [{ hooks: [{ type: "command", command: helper, timeout: 3 }] }],
    ]),
  );
  const mcp = {
    command: nodePath,
    args: [join(runtimeDir, "mcp.cjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  if (provider === "claude")
    return { hooks, mcp, args: resumeId ? ["--resume", resumeId] : [] };
  return {
    hooks,
    mcp,
    args: [
      ...(resumeId ? ["resume", resumeId] : []),
      "-c",
      `hooks=${toml(hooks)}`,
      "-c",
      `mcp_servers.werk_task_context=${toml({ ...mcp, env_vars: ["WERK_SOCKET", "WERK_SESSION_ID", "WERK_SESSION_TOKEN"] })}`,
    ],
  };
}
// App-owned policy is supplied through each provider's instruction channel.
// Keep task titles and other session data in the user prompt/MCP context.
export function benchdeskInstructions(mode: Mode) {
  const context =
    memoryInstruction + brainInstruction +
    " Je werkt in Benchdesk. Haal eerst get_task_context op; gebruik alleen beschikbare bedrijfsdiensten. Gmail: gmail_list_accounts bepaalt toegestane accounts; gmail_create_draft verstuurt niets. Behoud normale toestemmingen. Verzin geen bedrijfsgegevens. Nieuwe plannen, doelen en taken blijven voorstellen tot gebruikersacceptatie. ";
  if (mode === "intake")
    return (
      context +
      "Voer een korte zakelijke intake met mij uit: aanbod, doelgroep, fase, huidig knelpunt en het belangrijkste meetbare doel. Lees de gekoppelde bedrijfsdocumenten waar nuttig. Stel gerichte vragen en dien pas na het gesprek een voorstel in via propose_company_context. Bestaande doelen niet dupliceren; nieuwe doelen alleen wanneer nodig. Voer geen uitvoerende taken uit tijdens de intake."
    );
  if (mode === "suggestions")
    return (
      context +
      "Bedenk precies drie concrete NIEUWE taken die het bedrijf helpen zijn bestaande doelen te bereiken. Gebruik alle beschikbare bedrijfscontext: aanbod, doelgroep, knelpunt, doelen en actuele voortgang, afdelingen, projecten, bestaande en afgeronde taken, check-ins, eerdere voorstellen, sessiegeheugen en relevante gekoppelde bronnen. Lees relevante bronbestanden indien beschikbaar. Herhaal geen bestaande taken of afgewezen voorstellen. Koppel elk voorstel aan een bestaand project en een bestaand doel via hun echte IDs. Geef een korte concrete reden waarom dit nu bijdraagt aan dat doel, met bronverwijzingen naar de gebruikte context. Maak aannames expliciet en presenteer ze niet als feiten. Bij ontbrekende details mag een taak gericht onderzoek of validatie voorstellen. Zet status op todo; vul alleen echte deadlines en afhankelijkheden in. Dien alle drie in één keer in via propose_next_actions. Bewaar daarna je sessiegeheugen en stop. Voer geen voorgestelde taken uit en maak geen bestanden, conceptmails of externe wijzigingen. De gebruiker bepaalt per voorstel of het een taak wordt."
    );
  if (mode === "planning")
    return (
      context +
      "Analyseer welke open taken nu het meest bijdragen aan het bedrijfsdoel en het knelpunt. Weeg zakelijke impact, betrouwbare onderbouwing, verplichtingen, urgentie, afhankelijkheden en MIJN resterende inspanning. Dien via propose_priorities een gerangschikt voorstel met concrete redenen, bronverwijzingen en onzekerheid in. Geef geblokkeerde taken geen direct uitvoerbare plek. Stel ontbrekend werk eventueel via propose_tasks voor. Bij onvoldoende context: vraag mij eerst om verduidelijking. Voer de taken zelf niet uit."
    );
  return (
    context +
    "Meld betekenisvolle voortgang via report_progress. De opgegeven outputDirectory is de gekozen werkmap. Bewaar nieuwe bestanden en assets in die werkmap en volg de bestaande projectstructuur met passende submappen. Gebruik een andere bestemming als de gebruiker die expliciet aangeeft. Gebruik tempmappen alleen voor tijdelijke tussenbestanden; zet definitieve resultaten vóór oplevering in de werkmap. Gebruik .werk-results niet als standaardbestemming voor nieuw werk. Dien een klaar resultaat via submit_result in met samenvatting en bestaande bestandspaden. De gebruiker beoordeelt en rondt de taak af. Publicatie of verzending volgt mijn expliciete instructies en normale tooltoestemmingen."
  );
}

export function promptFor(mode: Mode, taskTitle?: string) {
  const request = {
    work: `Werk met mij aan de taak: ${taskTitle || "de geselecteerde taak"}.`,
    intake: "Voer een korte zakelijke intake met mij uit.",
    planning: "Stel voor welke open taken nu de hoogste prioriteit hebben.",
    suggestions: "Stel precies drie nieuwe taken voor die bijdragen aan de bestaande bedrijfsdoelen.",
  }[mode];
  return `${request} Haal eerst de actuele taakcontext op via get_task_context.`;
}
