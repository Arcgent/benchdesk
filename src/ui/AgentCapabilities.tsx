import { useEffect, useState } from "react";
import { t as tr } from "../shared/i18n";
import {
  agentInput,
  agentRoutineInput,
  type AgentProfile,
  type AgentRoutine,
  type AgentSearchResult,
  type AgentSkill,
} from "../shared/agents";
import { api, useWorkbench } from "./model";
import { Button, Field, Input, Textarea, Select, StatusDot } from "./rz";
import { GmailSessionChoice } from "./Integrations";
import { useDesign } from "./Theme";

export function AgentHistory({ agent }: { agent: AgentProfile }) {
  const { run, navigate } = useWorkbench();
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<AgentSearchResult[]>([]),
    [searched, setSearched] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <section className="agent-capability">
      <h2>{tr("Gesprekken doorzoeken")}</h2>
      <p className="agent-muted">
        {tr(
          "Zoek in berichten van jou en deze agent. Tooluitvoer wordt niet doorzocht.",
        )}
      </p>
      <form
        className="agent-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void run(async () => {
            setResults(await api("agent.search", { id: agent.id, query }));
            setSearched(true);
          }).finally(() => setBusy(false));
        }}
      >
        <Input
          aria-label={tr("Zoekterm")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          minLength={2}
          maxLength={200}
          required
        />
        <Button type="submit" disabled={busy || query.trim().length < 2}>
          {tr("Zoeken")}
        </Button>
      </form>
      {searched && !results.length && (
        <p role="status">{tr("Geen berichten gevonden.")}</p>
      )}
      <div className="agent-results">
        {results.map((r) => (
          <button
            key={`${r.conversationId}:${r.itemId}`}
            onClick={() => navigate(`agent:${agent.id}:${r.conversationId}`)}
          >
            <strong>{r.title || tr("Nieuw gesprek")}</strong>
            <small>{new Date(r.createdAt).toLocaleString()}</small>
            <p>{r.text}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

export function AgentSkills({ agent }: { agent: AgentProfile }) {
  const { run } = useWorkbench();
  const minimal = useDesign() === "minimaal";
  const [editing, setEditing] = useState<AgentSkill | null>(null),
    [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [trigger, setTrigger] = useState(""),
    [content, setContent] = useState(""),
    [busy, setBusy] = useState(false);
  const edit = (skill?: AgentSkill) => {
    setEditing(skill || null);
    setName(skill?.name || "");
    setTrigger(skill?.trigger || "");
    setContent(skill?.content || "");
    setOpen(true);
  };
  return (
    <section className="agent-capability">
      <div className="agent-section-head">
        <h2>{tr("Werkwijzen")}</h2>
        {/* Minimaal: an unavailable action is not shown instead of shown disabled. */}
        {!(minimal && agent.archived) && (
          <Button onClick={() => edit()} disabled={agent.archived}>
            {tr("Nieuwe skill")}
          </Button>
        )}
      </div>
      <p className="agent-muted">
        {tr(
          "Herbruikbare stappen met een duidelijk toepassingsmoment. Je agent kan ze tijdens het werk aanvullen.",
        )}
      </p>
      {!agent.skills.length && !open && (
        <p>{tr("Nog geen skills. Leg je eerste werkwijze vast.")}</p>
      )}
      {agent.skills.map((s) => (
        <article className="agent-capability-card" key={s.id}>
          <div className="agent-section-head">
            <h3>{s.name}</h3>
            <label>
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={agent.archived || busy}
                onChange={() =>
                  void run(() =>
                    api("agent.skill.save", {
                      agentId: agent.id,
                      id: s.id,
                      expectedRevision: s.revision,
                      value: {
                        name: s.name,
                        trigger: s.trigger,
                        content: s.content,
                        enabled: !s.enabled,
                      },
                    }),
                  )
                }
              />{" "}
              {tr("Actief")}
            </label>
          </div>
          <p>{s.trigger}</p>
          <details>
            <summary>{tr("Werkwijze bekijken")}</summary>
            <pre className="agent-procedure">{s.content}</pre>
          </details>
          {!(minimal && agent.archived) && (
            <div className="agent-settings__actions">
              <Button
                variant={minimal ? "quiet" : undefined}
                disabled={agent.archived}
                onClick={() => edit(s)}
              >
                {tr("Bewerken")}
              </Button>
              <Button
                variant={minimal ? "quiet" : undefined}
                disabled={agent.archived}
                onClick={() => {
                  if (window.confirm(tr("Deze skill verwijderen?")))
                    void run(() =>
                      api("agent.skill.remove", {
                        agentId: agent.id,
                        id: s.id,
                        expectedRevision: s.revision,
                      }),
                    );
                }}
              >
                {tr("Verwijderen")}
              </Button>
            </div>
          )}
        </article>
      ))}
      {open && (
        <form
          className="agent-capability-card agent-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void run(async () => {
              await api("agent.skill.save", {
                agentId: agent.id,
                id: editing?.id,
                expectedRevision: editing?.revision,
                value: {
                  name,
                  trigger,
                  content,
                  enabled: editing?.enabled ?? true,
                },
              });
              setOpen(false);
            }).finally(() => setBusy(false));
          }}
        >
          <Field label={tr("Naam")}>
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={tr("Wanneer gebruiken?")}>
            <Textarea
              required
              maxLength={1000}
              rows={2}
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            />
          </Field>
          <Field label={tr("Stappen en controle")}>
            <Textarea
              required
              maxLength={12000}
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
          <div className="agent-settings__actions">
            <Button type="submit" disabled={busy || agent.archived}>
              {tr("Opslaan")}
            </Button>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              {tr("Annuleren")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

export function AgentPermissions({ agent }: { agent: AgentProfile }) {
  const { snap, run } = useWorkbench();
  const [base, setBase] = useState(agent),
    [access, setAccess] = useState(agent.access),
    [places, setPlaces] = useState(agent.access.places.join("\n")),
    [busy, setBusy] = useState(false);
  // Keep unsaved edits visible when another update changes the profile revision.
  const patch = (value: Partial<typeof access>) =>
    setAccess({ ...access, ...value });
  return (
    <form
      className="agent-capability agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void run(async () => {
          await api("agent.save", {
            id: agent.id,
            expectedRevision: base.revision,
            value: {
              ...agentInput.strip().parse(base),
              access: {
                ...access,
                places: places
                  .split("\n")
                  .map((p) => p.trim())
                  .filter(Boolean),
              },
            },
          });
          setBase({ ...base, revision: base.revision + 1 });
        }).finally(() => setBusy(false));
      }}
    >
      <h2>{tr("Rechten en samenwerking")}</h2>
      <Field label={tr("Extra werkmappen")}>
        <Textarea
          rows={3}
          value={places}
          onChange={(e) => setPlaces(e.target.value)}
          placeholder="/pad/naar/map"
        />
      </Field>
      <p className="agent-muted">
        {tr(
          "Eén absolute map per regel, naast de bedrijfs- of projectmap. De uitvoerder blijft zijn eigen bestandsrechten en toestemmingen toepassen.",
        )}
      </p>
      <fieldset>
        <legend>{tr("Benchdesk-koppelingen")}</legend>
        <div className="agent-checks">
          {(
            ["gmail", "github", "fireflies", "pocket", "unipile", "blotato"] as const
          ).map(
            (provider) => (
              <label key={provider}>
                <input
                  type="checkbox"
                  checked={access.integrations.includes(provider)}
                  onChange={(e) =>
                    patch({
                      integrations: e.target.checked
                        ? [...access.integrations, provider]
                        : access.integrations.filter((x) => x !== provider),
                    })
                  }
                />
                {provider === "github"
                  ? "GitHub"
                  : provider === "gmail"
                    ? "Gmail"
                    : provider[0].toUpperCase() + provider.slice(1)}
              </label>
            ),
          )}
        </div>
      </fieldset>
      <p className="agent-muted">
        {tr(
          "Bedrijfs- en gesprekstoestemmingen blijven ook gelden. Deze keuze beheert alleen koppelingen via Benchdesk.",
        )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={access.routines}
          onChange={(e) => patch({ routines: e.target.checked })}
        />{" "}
        {tr("Routines toestaan")}
      </label>
      <label>
        <input
          type="checkbox"
          checked={access.messaging}
          onChange={(e) => patch({ messaging: e.target.checked })}
        />{" "}
        {tr("Overdracht tussen agents toestaan")}
      </label>
      {access.messaging && (
        <fieldset>
          <legend>{tr("Mag werk overdragen aan")}</legend>
          <div className="agent-checks">
            {(snap.agents || [])
              .filter(
                (a) =>
                  a.companyId === agent.companyId &&
                  a.id !== agent.id &&
                  !a.archived,
              )
              .map((a) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={access.teammates.includes(a.id)}
                    onChange={(e) =>
                      patch({
                        teammates: e.target.checked
                          ? [...access.teammates, a.id]
                          : access.teammates.filter((id) => id !== a.id),
                      })
                    }
                  />
                  {a.name}
                </label>
              ))}
          </div>
          <p className="agent-muted">
            {tr("De ontvangende agent moet overdracht ook toestaan.")}
          </p>
        </fieldset>
      )}
      {base.revision !== agent.revision && (
        <p role="alert">
          {tr("Agent is gewijzigd. Laad de laatste versie voordat je opslaat.")}{" "}
          <Button
            onClick={() => {
              setBase(agent);
              setAccess(agent.access);
              setPlaces(agent.access.places.join("\n"));
            }}
          >
            {tr("Laatste versie laden")}
          </Button>
        </p>
      )}
      <Button
        type="submit"
        disabled={busy || agent.archived || base.revision !== agent.revision}
      >
        {tr("Rechten opslaan")}
      </Button>
    </form>
  );
}

export function AgentRoutines({ agent }: { agent: AgentProfile }) {
  const { run, navigate, snap } = useWorkbench();
  const minimal = useDesign() === "minimaal";
  const [routines, setRoutines] = useState<AgentRoutine[]>([]),
    [editing, setEditing] = useState<AgentRoutine | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [loadError, setLoadError] = useState("");
  const blank = () =>
    agentRoutineInput.parse({
      agentId: agent.id,
      name: "Routine",
      prompt: "Opdracht",
      schedule: "daily",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  const [value, setValue] = useState(blank);
  const load = async () =>
    setRoutines(await api("agent.routine.list", { agentId: agent.id }));
  useEffect(() => {
    let canceled = false;
    api<AgentRoutine[]>("agent.routine.list", { agentId: agent.id }).then(
      (rows) => {
        if (!canceled) {
          setRoutines(rows);
          setLoadError("");
        }
      },
      (e) => {
        if (!canceled) setLoadError(e.message);
      },
    );
    return () => {
      canceled = true;
    };
  }, [agent.id, snap]);
  const edit = (r?: AgentRoutine) => {
    setEditing(r || null);
    setValue(
      r ? agentRoutineInput.parse(r) : { ...blank(), name: "", prompt: "" },
    );
    setOpen(true);
  };
  const patch = (p: Partial<typeof value>) => setValue({ ...value, ...p });
  return (
    <section className="agent-capability">
      <div className="agent-section-head">
        <h2>{minimal ? tr("Terugkerend") : tr("Routines")}</h2>
        {!(minimal && agent.archived) && (
          <Button disabled={agent.archived} onClick={() => edit()}>
            {tr("Nieuwe routine")}
          </Button>
        )}
      </div>
      <p className="agent-muted">
        {tr(
          "Elke uitvoering opent een nieuw gesprek. Routines lopen zolang de lokale Benchdesk-service actief is. Gemiste uitvoeringen worden niet ingehaald.",
        )}
      </p>
      {!agent.access.routines && (
        <p role="status">
          {tr(
            "Sta routines eerst toe bij Instellingen → Rechten en samenwerking.",
          )}
        </p>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      {!routines.length && <p>{tr("Nog geen routines.")}</p>}
      {routines.map((r) => {
        const runNow = () => {
          setBusy(true);
          void run(async () => {
            const c = await api<{ conversationId: string }>(
              "agent.routine.run",
              { id: r.id },
            );
            navigate(`agent:${agent.id}:${c.conversationId}`);
          }).finally(() => setBusy(false));
        };
        const toggle = () =>
          void run(async () => {
            await api("agent.routine.save", {
              id: r.id,
              expectedRevision: r.revision,
              value: {
                ...agentRoutineInput.parse(r),
                enabled: !r.enabled,
              },
            });
            await load();
          });
        const remove = () => {
          if (
            window.confirm(
              tr("Deze routine verwijderen? Gesprekken blijven bewaard."),
            )
          )
            void run(async () => {
              await api("agent.routine.remove", {
                id: r.id,
                expectedRevision: r.revision,
              });
              await load();
            });
        };
        const openLast = () =>
          navigate(`agent:${agent.id}:${r.lastConversationId}`);
        const schedule =
          r.schedule === "interval"
            ? tr("Elke {0} minuten", r.minutes)
            : `${r.schedule === "daily" ? tr("Dagelijks") : tr("Wekelijks")} ${r.time} · ${r.timezone}`;
        if (minimal) {
          // Minimaal: a flat row. Actions that can't be used are left out; one pill, the rest quiet text.
          const canRun = !agent.archived && agent.access.routines;
          const canToggle =
            r.enabled || (agent.access.routines && !agent.archived);
          return (
            <article className="agent-capability-card" key={r.id}>
              <div className="agent-section-head">
                <h3>{r.name}</h3>
                <StatusDot
                  tone={r.enabled ? "text2" : "muted"}
                  label={r.enabled ? tr("Actief") : tr("Gepauzeerd")}
                />
              </div>
              <p>{r.prompt}</p>
              <small>{schedule}</small>
              {r.enabled && (
                <small>
                  {tr(
                    "Volgende uitvoering: {0}",
                    new Date(r.nextRunAt).toLocaleString(),
                  )}
                </small>
              )}
              {r.lastConversationId && (
                <small>
                  {tr(
                    "Laatste uitvoering: {0}",
                    r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : "—",
                  )}
                </small>
              )}
              {r.error && <p role="alert">{r.error}</p>}
              <div className="agent-settings__actions">
                {r.enabled
                  ? canRun && (
                      <Button disabled={busy} onClick={runNow}>
                        {tr("Nu uitvoeren")}
                      </Button>
                    )
                  : canToggle && (
                      <Button disabled={busy} onClick={toggle}>
                        {tr("Inschakelen")}
                      </Button>
                    )}
                {r.enabled
                  ? canToggle && (
                      <Button variant="quiet" disabled={busy} onClick={toggle}>
                        {tr("Pauzeren")}
                      </Button>
                    )
                  : canRun && (
                      <Button variant="quiet" disabled={busy} onClick={runNow}>
                        {tr("Nu uitvoeren")}
                      </Button>
                    )}
                <Button variant="quiet" onClick={() => edit(r)}>
                  {tr("Bewerken")}
                </Button>
                {r.lastConversationId && (
                  <Button variant="quiet" onClick={openLast}>
                    {tr("Laatste gesprek")}
                  </Button>
                )}
                <Button variant="quiet" onClick={remove}>
                  {tr("Verwijderen")}
                </Button>
              </div>
            </article>
          );
        }
        return (
          <article className="agent-capability-card" key={r.id}>
            <div className="agent-section-head">
              <h3>{r.name}</h3>
              <span>{r.enabled ? tr("Actief") : tr("Gepauzeerd")}</span>
            </div>
            <p>{r.prompt}</p>
            <small>{schedule}</small>
            {r.enabled && (
              <p>
                {tr(
                  "Volgende uitvoering: {0}",
                  new Date(r.nextRunAt).toLocaleString(),
                )}
              </p>
            )}
            {r.lastConversationId && (
              <p>
                {tr(
                  "Laatste uitvoering: {0}",
                  r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : "—",
                )}
              </p>
            )}
            {r.error && <p role="alert">{r.error}</p>}
            <div className="agent-settings__actions">
              <Button
                disabled={busy || agent.archived || !agent.access.routines}
                onClick={runNow}
              >
                {tr("Nu uitvoeren")}
              </Button>
              <Button
                disabled={
                  busy ||
                  (!r.enabled && (!agent.access.routines || agent.archived))
                }
                onClick={toggle}
              >
                {r.enabled ? tr("Pauzeren") : tr("Inschakelen")}
              </Button>
              <Button onClick={() => edit(r)}>{tr("Bewerken")}</Button>
              {r.lastConversationId && (
                <Button onClick={openLast}>{tr("Laatste gesprek")}</Button>
              )}
              <Button onClick={remove}>{tr("Verwijderen")}</Button>
            </div>
          </article>
        );
      })}
      {open && (
        <form
          className="agent-capability-card agent-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void run(async () => {
              await api("agent.routine.save", {
                id: editing?.id,
                expectedRevision: editing?.revision,
                value,
              });
              await load();
              setOpen(false);
            }).finally(() => setBusy(false));
          }}
        >
          <Field label={tr("Naam")}>
            <Input
              required
              maxLength={100}
              value={value.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={tr("Opdracht")}>
            <Textarea
              required
              rows={4}
              maxLength={12000}
              value={value.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
            />
          </Field>
          <Field label={tr("Herhaling")}>
            <Select
              aria-label={tr("Herhaling")}
              value={value.schedule}
              onChange={(e) =>
                patch({ schedule: e.target.value as typeof value.schedule })
              }
            >
              <option value="daily">{tr("Dagelijks")}</option>
              <option value="weekly">{tr("Wekelijks")}</option>
              <option value="interval">{tr("Interval")}</option>
            </Select>
          </Field>
          {value.schedule === "interval" ? (
            <Field label={tr("Minuten tussen uitvoeringen")}>
              <Input
                type="number"
                min={15}
                max={10080}
                required
                value={value.minutes}
                onChange={(e) => patch({ minutes: Number(e.target.value) })}
              />
            </Field>
          ) : (
            <Field label={tr("Tijd")}>
              <Input
                type="time"
                required
                value={value.time}
                onChange={(e) => patch({ time: e.target.value })}
              />
            </Field>
          )}
          {value.schedule === "weekly" && (
            <Field label={tr("Weekdag")}>
              <Select
                aria-label={tr("Weekdag")}
                value={value.weekday}
                onChange={(e) => patch({ weekday: Number(e.target.value) })}
              >
                {Array.from({ length: 7 }, (_, d) => (
                  <option key={d} value={d}>
                    {new Date(2026, 8, 20 + d).toLocaleDateString(undefined, {
                      weekday: "long",
                    })}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={tr("Tijdzone")}>
            <Input
              required
              value={value.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
            />
          </Field>
          {agent.access.integrations.includes("gmail") && (
            <GmailSessionChoice
              value={value.gmailAccess}
              onChange={(gmailAccess) => patch({ gmailAccess })}
            />
          )}
          <label>
            <input
              type="checkbox"
              checked={value.enabled}
              disabled={!agent.access.routines || agent.archived}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />{" "}
            {tr("Inschakelen")}
          </label>
          <div className="agent-settings__actions">
            <Button type="submit" disabled={busy}>
              {tr("Opslaan")}
            </Button>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              {tr("Annuleren")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

export function AgentHandoff({
  agent,
  conversationId,
  close,
}: {
  agent: AgentProfile;
  conversationId: string;
  close: () => void;
}) {
  const { snap, run, navigate } = useWorkbench();
  const peers = (snap.agents || []).filter(
    (a) =>
      a.companyId === agent.companyId &&
      a.id !== agent.id &&
      !a.archived &&
      a.access.messaging &&
      agent.access.teammates.includes(a.id),
  );
  const [target, setTarget] = useState(peers[0]?.id || ""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="agent-capability-card agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void run(async () => {
          const c = await api<{ conversationId: string; agentId: string }>(
            "chat.handoff",
            { id: conversationId, agentId: target, message },
          );
          close();
          navigate(`agent:${c.agentId}:${c.conversationId}`);
        }).finally(() => setBusy(false));
      }}
    >
      <h3>{tr("Werk overdragen")}</h3>
      <p className="agent-muted">
        {tr(
          "De collega krijgt deze opdracht in een nieuw gesprek, met eigen rechten. De gekoppelde taak blijft bij dit gesprek.",
        )}
      </p>
      {!agent.access.messaging || !peers.length ? (
        <p>
          {tr(
            "Kies eerst toegestane collega’s bij Instellingen → Rechten en samenwerking.",
          )}
        </p>
      ) : (
        <>
          <Field label={tr("Agent")}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {peers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr("Opdracht en context")}>
            <Textarea
              required
              rows={4}
              maxLength={12000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || !message.trim()}>
            {tr("Overdragen")}
          </Button>
        </>
      )}
      <Button onClick={close} disabled={busy}>
        {tr("Annuleren")}
      </Button>
    </form>
  );
}
