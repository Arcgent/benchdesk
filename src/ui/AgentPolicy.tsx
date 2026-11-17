import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Trash2, X } from "lucide-react";
import { t as tr, locale } from "../shared/i18n";
import {
  agentInput,
  type AgentAuditRow,
  type AgentProfile,
} from "../shared/agents";
import {
  agentPolicy,
  classify,
  evaluatePolicy,
  type AgentPolicy as Policy,
  type PolicyEffect,
  type PolicyRule,
  type PolicySource,
  type PolicyVerdict,
} from "../shared/policy";
import { api, useWorkbench } from "./model";
import { Button, Field, IconButton, Input, Select } from "./rz";

const verdictLabel = (v: string) =>
  v === "deny" ? tr("Weigeren") : v === "ask" ? tr("Vragen") : tr("Toestaan");
const sourceLabel = (s: string) =>
  s === "werk"
    ? tr("Benchdesk-tools")
    : s === "builtin"
      ? tr("Provider-tools")
      : s === "plugin"
        ? tr("Plugins")
        : tr("Computer");
const effectLabel = (e: string) =>
  e === "read" ? tr("Lezen") : e === "write" ? tr("Schrijven") : tr("Intern");
const outcomeLabel = (o: string) =>
  o === "ok"
    ? tr("Uitgevoerd")
    : o === "error"
      ? tr("Mislukt")
      : o === "denied"
        ? tr("Tegengehouden")
        : o === "declined"
          ? tr("Door jou geweigerd")
          : tr("Wacht op goedkeuring");
const verdicts: PolicyVerdict[] = ["deny", "ask", "allow"];
const sources: PolicySource[] = ["werk", "builtin", "plugin", "computer"];
const effects: PolicyEffect[] = ["read", "write", "internal"];

function VerdictChip({ verdict }: { verdict: string }) {
  return (
    <span className={`agent-verdict agent-verdict--${verdict}`}>
      {verdictLabel(verdict)}
    </span>
  );
}
function RuleSummary({ rule }: { rule: PolicyRule }) {
  const m = rule.match,
    parts: ReactNode[] = [];
  if (m.source) parts.push(sourceLabel(m.source));
  if (m.effect) parts.push(effectLabel(m.effect).toLowerCase());
  for (const [key, label] of [
    ["tool", tr("tool")],
    ["server", tr("server")],
    ["host", tr("site")],
    ["path", tr("pad")],
    ["command", tr("commando past bij")],
  ] as const)
    if (m[key])
      parts.push(
        <>
          {label} <code>{m[key]}</code>
        </>,
      );
  if (!parts.length) return <>{tr("Elke actie")}</>;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </>
  );
}

function RuleEditor({
  rule,
  save,
  cancel,
}: {
  rule: PolicyRule;
  save: (rule: PolicyRule) => void;
  cancel: () => void;
}) {
  const [draft, setDraft] = useState(rule);
  const match = (key: keyof PolicyRule["match"], value: string) =>
    setDraft({
      ...draft,
      match: { ...draft.match, [key]: value.trim() ? value : undefined },
    });
  const regexError = (() => {
    try {
      if (draft.match.command) new RegExp(draft.match.command);
      return "";
    } catch {
      return tr("Dit is geen geldige reguliere expressie.");
    }
  })();
  return (
    <form
      className="agent-policy__editor"
      onSubmit={(e) => {
        e.preventDefault();
        save({
          ...draft,
          match: Object.fromEntries(
            Object.entries(draft.match)
              .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
              .filter(([, v]) => v),
          ),
        });
      }}
    >
      <div className="agent-policy__grid">
        <Field label={tr("Besluit")}>
          <Select
            value={draft.verdict}
            onChange={(e) =>
              setDraft({ ...draft, verdict: e.target.value as PolicyVerdict })
            }
          >
            {verdicts.map((v) => (
              <option key={v} value={v}>
                {verdictLabel(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr("Bron")}>
          <Select
            value={draft.match.source || ""}
            onChange={(e) => match("source", e.target.value)}
          >
            <option value="">{tr("Alle bronnen")}</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr("Soort actie")}>
          <Select
            value={draft.match.effect || ""}
            onChange={(e) => match("effect", e.target.value)}
          >
            <option value="">{tr("Alle soorten")}</option>
            {effects.map((s) => (
              <option key={s} value={s}>
                {effectLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr("Tool (* mag)")}>
          <Input
            value={draft.match.tool || ""}
            maxLength={500}
            placeholder="Bash, gmail_*"
            onChange={(e) => match("tool", e.target.value)}
          />
        </Field>
        <Field label={tr("Website (* mag)")}>
          <Input
            value={draft.match.host || ""}
            maxLength={500}
            placeholder="*.linkedin.com"
            onChange={(e) => match("host", e.target.value)}
          />
        </Field>
        <Field label={tr("Pad (* mag)")}>
          <Input
            value={draft.match.path || ""}
            maxLength={500}
            placeholder="/pad/naar/klanten/*"
            onChange={(e) => match("path", e.target.value)}
          />
        </Field>
        <Field
          label={tr("Commando (reguliere expressie)")}
          error={regexError}
          className="agent-policy__wide"
        >
          <Input
            value={draft.match.command || ""}
            maxLength={500}
            placeholder="^git push"
            onChange={(e) => match("command", e.target.value)}
          />
        </Field>
        <Field label={tr("Notitie")}>
          <Input
            value={draft.note}
            maxLength={300}
            placeholder={tr("Waarom deze regel?")}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
        </Field>
      </div>
      <div className="agent-policy__foot">
        <Button onClick={cancel}>{tr("Annuleren")}</Button>
        <Button type="submit" variant="primary" disabled={!!regexError}>
          {tr("Regel opslaan")}
        </Button>
      </div>
    </form>
  );
}

function PolicyTester({ policy }: { policy: Policy }) {
  const [source, setSource] = useState<PolicySource>("builtin"),
    [tool, setTool] = useState("Bash"),
    [value, setValue] = useState("rm -rf tmp");
  const input =
    source === "builtin"
      ? tool === "Bash"
        ? { command: value }
        : /^(Read|Edit|Write|NotebookEdit)$/.test(tool)
          ? { file_path: value }
          : { url: value }
      : source === "computer"
        ? { url: value }
        : {};
  const call = classify(source, tool.trim(), input),
    result = evaluatePolicy(policy, call),
    rule = policy.rules.find((r) => r.id === result.ruleId);
  return (
    <div className="agent-capability-card agent-policy__tester">
      <div className="agent-policy__grid">
        <Field label={tr("Bron")}>
          <Select
            value={source}
            onChange={(e) => setSource(e.target.value as PolicySource)}
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr("Tool")}>
          <Input value={tool} onChange={(e) => setTool(e.target.value)} />
        </Field>
        <Field label={tr("Commando, pad of URL")}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <div className="agent-policy__result" role="status">
        <VerdictChip verdict={result.verdict} />
        <span>
          {effectLabel(call.effect)} ·{" "}
          {rule ? (
            <>
              {tr("door regel:")}{" "}
              <b>{rule.note || <RuleSummary rule={rule} />}</b>
            </>
          ) : (
            tr("standaard voor {0}", effectLabel(call.effect).toLowerCase())
          )}
        </span>
        {result.effective !== result.verdict && (
          <span className="agent-muted">
            {tr("Proefdraaien: gaat toch door")}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentPolicy({ agent }: { agent: AgentProfile }) {
  const { run } = useWorkbench();
  const [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<PolicyRule | null>(null);
  const policy = agent.access.policy;
  const save = (next: Policy) => {
    setBusy(true);
    return run(async () => {
      await api("agent.save", {
        id: agent.id,
        expectedRevision: agent.revision,
        value: {
          ...agentInput.strip().parse(agent),
          access: { ...agent.access, policy: agentPolicy.parse(next) },
        },
      });
      return true;
    }).finally(() => setBusy(false));
  };
  const dry = policy.mode === "dry_run";
  const locked = busy || agent.archived;
  return (
    <section className="agent-capability agent-policy">
      <div className={`agent-capability-card agent-policy__mode${dry ? " is-dry" : ""}`}>
        <div>
          <h3>
            {dry ? tr("Proefdraaien") : tr("Regels worden afgedwongen")}
          </h3>
          <p className="agent-muted">
            {dry
              ? tr(
                  "Alles gaat door, maar het logboek laat zien wat de regels zouden hebben tegengehouden. Handig om regels te testen zonder je agent te blokkeren.",
                )
              : tr(
                  "Elke actie van deze agent gaat langs deze regels. Weigeren wint altijd van vragen, vragen van toestaan.",
                )}
          </p>
        </div>
        <div className="agent-policy__seg" role="group" aria-label={tr("Modus")}>
          {(["enforce", "dry_run"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={locked}
              aria-pressed={policy.mode === mode}
              onClick={() => void save({ ...policy, mode })}
            >
              {mode === "enforce" ? tr("Afdwingen") : tr("Proefdraaien")}
            </button>
          ))}
        </div>
      </div>

      <div className="agent-section-head">
        <h2>{tr("Standaard")}</h2>
        <span className="agent-muted">{tr("Geldt als geen regel past")}</span>
      </div>
      <div className="agent-capability-card agent-policy__defaults">
        {effects.map((effect) => (
          <Field
            key={effect}
            label={effectLabel(effect)}
            hint={
              effect === "read"
                ? tr("Bestanden lezen, zoeken, context ophalen")
                : effect === "write"
                  ? tr(
                      "Bestanden wijzigen, commando's, e-mailconcepten, overdrachten",
                    )
                  : tr("Geheugen, voortgang, voorstellen die jij nog beoordeelt")
            }
          >
            <Select
              value={policy.defaults[effect]}
              disabled={locked}
              onChange={(e) =>
                void save({
                  ...policy,
                  defaults: {
                    ...policy.defaults,
                    [effect]: e.target.value as PolicyVerdict,
                  },
                })
              }
            >
              {verdicts.map((v) => (
                <option key={v} value={v}>
                  {verdictLabel(v)}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>

      <div className="agent-section-head">
        <h2>{tr("Regels")}</h2>
        <Button
          plus
          disabled={locked || !!editing || policy.rules.length >= 100}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              enabled: true,
              verdict: "deny",
              note: "",
              match: {},
            })
          }
        >
          {tr("Regel toevoegen")}
        </Button>
      </div>
      <div className="agent-capability-card agent-policy__rules">
        {!policy.rules.length && !editing && (
          <p className="agent-muted">
            {tr("Nog geen regels. De standaard hierboven bepaalt alles.")}
          </p>
        )}
        <ul>
          {policy.rules.map((rule) => (
            <li key={rule.id} className={rule.enabled ? "" : "is-off"}>
              <VerdictChip verdict={rule.verdict} />
              <div className="agent-policy__what">
                <b>
                  <RuleSummary rule={rule} />
                </b>
                {rule.note && <span className="agent-muted">{rule.note}</span>}
              </div>
              <div className="agent-policy__actions">
                <input
                  type="checkbox"
                  role="switch"
                  className="agent-policy__switch"
                  aria-label={tr("Regel aan of uit")}
                  checked={rule.enabled}
                  disabled={locked}
                  onChange={() =>
                    void save({
                      ...policy,
                      rules: policy.rules.map((r) =>
                        r.id === rule.id ? { ...r, enabled: !r.enabled } : r,
                      ),
                    })
                  }
                />
                <IconButton
                  label={tr("Bewerken")}
                  size="sm"
                  disabled={locked || !!editing}
                  onClick={() => setEditing(rule)}
                >
                  <Pencil size={14} />
                </IconButton>
                <IconButton
                  label={tr("Verwijderen")}
                  size="sm"
                  disabled={locked}
                  onClick={() =>
                    void save({
                      ...policy,
                      rules: policy.rules.filter((r) => r.id !== rule.id),
                    })
                  }
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <RuleEditor
            key={editing.id}
            rule={editing}
            cancel={() => setEditing(null)}
            save={(rule) =>
              void save({
                ...policy,
                rules: policy.rules.some((r) => r.id === rule.id)
                  ? policy.rules.map((r) => (r.id === rule.id ? rule : r))
                  : [...policy.rules, rule],
              }).then((ok) => ok && setEditing(null))
            }
          />
        )}
      </div>

      <div className="agent-section-head">
        <h2>{tr("Probeer een actie")}</h2>
        <span className="agent-muted">{tr("Zelfde beslisregels als de agent")}</span>
      </div>
      <PolicyTester policy={policy} />

      <div className="agent-section-head">
        <h2>{tr("Wat wordt afgedwongen")}</h2>
      </div>
      <div className="agent-capability-card agent-policy__coverage">
        <div>
          <h3>Claude</h3>
          <p className="agent-muted">
            {tr(
              "Alle acties: Benchdesk-tools, bestanden, commando's, web en je eigen MCP-servers.",
            )}
          </p>
        </div>
        <div>
          <h3>Codex</h3>
          <p className="agent-muted">
            {tr(
              "Benchdesk-tools volledig. Commando's en bestanden alleen als Codex buiten zijn sandbox wil; binnen de sandbox beslist Codex zelf.",
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

export function AgentAudit({ agent }: { agent: AgentProfile }) {
  const { run, navigate } = useWorkbench();
  const [rows, setRows] = useState<AgentAuditRow[]>([]),
    [next, setNext] = useState<number | null>(null),
    [verdict, setVerdict] = useState<PolicyVerdict | "all">("all"),
    [source, setSource] = useState<PolicySource | "all">("all"),
    [open, setOpen] = useState<AgentAuditRow | null>(null),
    [loaded, setLoaded] = useState(false);
  const load = (before: number | null) =>
    run(async () => {
      const page = await api<{ items: AgentAuditRow[]; next: number | null }>(
        "agent.audit.list",
        {
          agentId: agent.id,
          filter: {
            before,
            limit: 50,
            ...(verdict === "all" ? {} : { verdict }),
            ...(source === "all" ? {} : { source }),
          },
        },
      );
      setRows((old) => (before ? [...old, ...page.items] : page.items));
      setNext(page.next);
      setLoaded(true);
    });
  useEffect(() => {
    void load(null);
  }, [agent.id, verdict, source]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const time = (iso: string) =>
    new Date(iso).toLocaleString(locale(), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  let args = "";
  try {
    args = open ? JSON.stringify(JSON.parse(open.args), null, 2) : "";
  } catch {
    args = open?.args || "";
  }
  return (
    <section className="agent-capability agent-audit">
      <div className="agent-section-head">
        <h2>{tr("Logboek")}</h2>
        <span className="agent-muted">
          {tr("Elke actie van deze agent, vastgelegd vóór uitvoering · 90 dagen bewaard")}
        </span>
      </div>
      <div className="agent-audit__filters">
        {(["all", ...verdicts] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={verdict === v}
            onClick={() => setVerdict(v)}
          >
            {v === "all"
              ? tr("Alles")
              : v === "deny"
                ? tr("Geweigerd")
                : v === "ask"
                  ? tr("Gevraagd")
                  : tr("Toegestaan")}
          </button>
        ))}
        <span className="agent-audit__gap" />
        {(["all", ...sources] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={source === s}
            onClick={() => setSource(s)}
          >
            {s === "all" ? tr("Alle bronnen") : sourceLabel(s)}
          </button>
        ))}
      </div>
      <div className="agent-capability-card agent-audit__card">
        {loaded && !rows.length ? (
          <p className="agent-muted">
            {tr("Nog niets vastgelegd met deze filters.")}
          </p>
        ) : (
          <table className="agent-audit__table">
            <thead>
              <tr>
                <th>{tr("Tijd")}</th>
                <th>{tr("Actie")}</th>
                <th className="agent-audit__wide">{tr("Doel")}</th>
                <th>{tr("Besluit")}</th>
                <th className="agent-audit__wide">{tr("Uitkomst")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                >
                  <td className="agent-audit__time">{time(r.at)}</td>
                  <td>
                    <code>{r.tool}</code>
                  </td>
                  <td className="agent-audit__target agent-audit__wide" title={r.target}>
                    {r.target || "—"}
                  </td>
                  <td>
                    <VerdictChip verdict={r.verdict} />
                  </td>
                  <td className="agent-audit__outcome agent-audit__wide">
                    {outcomeLabel(r.outcome)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {next && (
          <div className="agent-audit__more">
            <Button onClick={() => void load(next)}>{tr("Meer laden")}</Button>
          </div>
        )}
      </div>
      {open && (
        <div className="agent-audit__backdrop" onClick={() => setOpen(null)}>
          <aside
            className="agent-audit__drawer"
            role="dialog"
            aria-label={tr("Details")}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h3>{open.tool}</h3>
              <IconButton label={tr("Sluiten")} size="sm" onClick={() => setOpen(null)}>
                <X size={15} />
              </IconButton>
            </header>
            <dl>
              <dt>{tr("Besluit")}</dt>
              <dd>
                <VerdictChip verdict={open.verdict} />
                {open.effective !== open.verdict && (
                  <span className="agent-muted"> {tr("Proefdraaien: gaat toch door")}</span>
                )}
              </dd>
              <dt>{tr("Reden")}</dt>
              <dd>{open.reason}</dd>
              <dt>{tr("Uitkomst")}</dt>
              <dd>
                {outcomeLabel(open.outcome)}
                {open.durationMs != null && ` · ${open.durationMs} ms`}
              </dd>
              <dt>{tr("Bron")}</dt>
              <dd>
                {sourceLabel(open.source)} · {effectLabel(open.effect)}
              </dd>
              <dt>{tr("Gestart door")}</dt>
              <dd>
                {open.initiator === "handoff"
                  ? tr("Overdracht van een andere agent")
                  : open.initiator === "routine"
                    ? tr("Routine")
                    : tr("Gesprek")}
              </dd>
              <dt>{tr("Tijd")}</dt>
              <dd>{new Date(open.at).toLocaleString(locale())}</dd>
              {open.target && (
                <>
                  <dt>{tr("Doel")}</dt>
                  <dd>{open.target}</dd>
                </>
              )}
            </dl>
            <div>
              <span className="agent-muted">{tr("Invoer (geheimen verborgen)")}</span>
              <pre>{args}</pre>
            </div>
            {open.conversationId && (
              <Button
                onClick={() =>
                  navigate(`agent:${agent.id}:${open.conversationId}`)
                }
              >
                {tr("Open gesprek")}
              </Button>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
