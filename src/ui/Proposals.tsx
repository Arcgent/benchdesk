import { useEffect, useRef } from "react";
import { t as tr } from "../shared/i18n";
import { ArrowRight, Check } from "lucide-react";
import type { Proposal, Task } from "../shared/types";
import { applyProposedOrder } from "../shared/priorities";
import { api, useWorkbench } from "./model";
import { providerName, taskOrder } from "./primitives";
import {
  Button,
  Card,
  Cards,
  Chip,
  Crumbs,
  Empty,
  PageHead,
  PageShell,
  Section,
  SectionLabel,
  StatusDot,
  TextButton,
} from "./rz";
import { useDesign } from "./Theme";

type PriorityItem = { taskId: string; reason: string; evidence: string[] };
type ProposedTask = {
  projectId: string;
  title: string;
  description?: string;
  definitionDone?: string;
  criteria?: { text: string }[];
  estimateMinutes: number;
};
type ProposedGoal = {
  title: string;
  current: number;
  target: number;
  unit: string;
};
const contextFields = ["product", "audience", "stage", "bottleneck"] as const;

// Pages a proposal can be opened from: a Vandaag row, or the bell on any page. A project page has its id as view.
// The settings crumb reads like that page's own heading (Profile.tsx: the name, else "Jouw profiel").
const viewLabel = (view: string, profileName: string) =>
  view === "workspace"
    ? tr("Aan het werk")
    : view === "projects"
      ? tr("Projecten")
      : view === "tasks"
        ? tr("Alle taken")
        : view === "company"
          ? tr("Je bedrijf")
          : view === "schedules"
            ? tr("Terugkerend")
            : view === "integrations"
              ? tr("Koppelingen")
              : view === "accounts"
                ? tr("Accounts & gebruik")
                : view === "settings"
                  ? profileName || tr("Jouw profiel")
                  : "";

export function Proposals({
  proposal,
  from,
}: {
  proposal: Proposal;
  from?: string; // the view the user came from; without it the page leads back to Vandaag, as before
}) {
  const {
    snap,
    company,
    prefs,
    run,
    navigate,
    showProposal,
    openSession,
    launch,
  } = useWorkbench();
  // Minimaal: "Alles overnemen" is the one green pill; taking over a single change is a text action.
  const minimal = useDesign() === "minimaal";
  const session = snap.sessions.find((s) => s.id === proposal.sessionId),
    provider = session ? providerName(session.provider) : tr("Je assistent");
  const tasks = taskOrder(
    snap.tasks.filter(
      (t) => t.companyId === proposal.companyId && t.status !== "done",
    ),
  );
  const items: PriorityItem[] =
      proposal.kind === "priorities" ? proposal.payload.items || [] : [],
    proposed: ProposedTask[] =
      proposal.kind === "tasks" ? proposal.payload.tasks || [] : [],
    goals: ProposedGoal[] =
      proposal.kind === "context" ? proposal.payload.goals || [] : [];
  const decisions: Record<string, string> = proposal.payload.decisions || {};
  const pending = snap.proposals.filter(
    (p) =>
      p.companyId === proposal.companyId &&
      p.status === "pending" &&
      p.kind !== "suggestions",
  );
  // A decided proposal stays on screen: keep it in the picker so the control shows what you are looking at.
  const choices = pending.some((p) => p.id === proposal.id)
    ? pending
    : [proposal, ...pending];
  const stale =
    (proposal.kind === "priorities" || proposal.kind === "context") &&
    proposal.basisRevision !== company?.revision;
  const fromProject = snap.projects.find(
      (p) => p.id === from && p.companyId === proposal.companyId,
    ),
    fromLabel = from ? viewLabel(from, prefs.profile.name) : "",
    origin = fromProject
      ? { view: fromProject.id, label: fromProject.name }
      : from && fromLabel
        ? { view: from, label: fromLabel }
        : { view: "today", label: tr("Vandaag") };
  const kindLabel = (p: Proposal) =>
    p.kind === "priorities"
      ? tr("Prioriteiten")
      : p.kind === "tasks"
        ? tr("Nieuwe taken")
        : tr("Bedrijfsprofiel");
  const choiceLabel = (p: Proposal) => {
    const by = snap.sessions.find((s) => s.id === p.sessionId);
    return by ? `${kindLabel(p)} · ${providerName(by.provider)}` : kindLabel(p);
  };
  const apply = (accept: boolean) =>
    void run(
      async () => {
        await api("proposal.decide", { id: proposal.id, accept });
        const next = pending.find((p) => p.id !== proposal.id);
        if (next) showProposal(next);
        else navigate(origin.view);
      },
      accept ? tr("Voorstel overgenomen.") : tr("Voorstel afgewezen."),
    );
  // Deciding a change unmounts the button that had the focus: its result label takes the focus over, so a keyboard
  // user stays on the card (and hears the result) instead of starting again at the top of the page.
  const changes = useRef<HTMLDivElement>(null),
    decided = useRef("");
  useEffect(() => {
    const id = decided.current;
    if (!id || !decisions[id]) return;
    decided.current = "";
    if (document.activeElement && document.activeElement !== document.body)
      return;
    [...(changes.current?.children || [])]
      .find((el) => el.getAttribute("data-task-id") === id)
      ?.querySelector<HTMLElement>('[tabindex="-1"]')
      ?.focus();
  });
  const decide = (taskId: string, accept: boolean) => {
    decided.current = taskId;
    void run(() => api("proposal.item", { id: proposal.id, taskId, accept }));
  };
  const clarify = () => {
    if (!session) return;
    if (session.alive && session.agentRunning)
      void run(async () => {
        await api("session.message", {
          id: session.id,
          message: tr(
            "Kun je je laatste voorstel toelichten? Leg uit waarom je deze wijzigingen adviseert, welke bronnen je gebruikt en waar je nog onzeker over bent.",
          ),
        });
        openSession(session);
      });
    else
      launch({
        mode: session.mode,
        companyId: session.companyId,
        ...(session.providerSessionId ? { resume: session } : {}),
      });
  };
  const kept = items.filter((item) => decisions[item.taskId] !== "dismissed"),
    order =
      proposal.kind === "priorities"
        ? applyProposedOrder(
            tasks,
            kept
              .map((item) => tasks.find((t) => t.id === item.taskId))
              .filter((t): t is Task => !!t),
            new Set(kept.map((item) => item.taskId)),
          )
        : [];
  return (
    <PageShell
      width={proposal.kind === "priorities" ? "wide" : "normal"}
      className="rz-proposals"
      data-test="proposal-page"
      data-proposal-id={proposal.id}
    >
      <PageHead
        variant="sentence"
        crumbs={
          <Crumbs
            items={[
              { label: origin.label, onClick: () => navigate(origin.view) },
              {
                label: (
                  <>
                    {tr("Voorstel:")}{" "}
                    {proposal.kind === "priorities"
                      ? tr("prioriteiten")
                      : proposal.kind === "tasks"
                        ? tr("nieuwe taken")
                        : tr("bedrijfsprofiel")}
                  </>
                ),
              },
            ]}
          />
        }
        title={
          proposal.kind === "priorities"
            ? items.length === 1
              ? tr("{0} stelt één wijziging voor in je volgorde", provider)
              : !items.length
                ? tr("{0} stelt geen wijzigingen voor in je volgorde", provider)
                : tr(
                    "{0} stelt {1} wijzigingen voor in je volgorde",
                    provider,
                    items.length,
                  )
            : proposal.kind === "tasks"
              ? proposed.length === 1
                ? tr("{0} stelt één nieuwe taak voor", provider)
                : tr(
                    "{0} stelt {1} nieuwe taken voor",
                    provider,
                    proposed.length,
                  )
              : tr("{0} stelt een scherper bedrijfsprofiel voor", provider)
        }
        actions={
          pending.length > 1 && (
            <Chip
              chevron
              control={
                <select
                  aria-label={tr("Voorstel kiezen")}
                  value={proposal.id}
                  onChange={(e) => {
                    const p = pending.find((p) => p.id === e.target.value);
                    if (p) showProposal(p);
                  }}
                >
                  {choices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {choiceLabel(p)}
                    </option>
                  ))}
                </select>
              }
            >
              {choiceLabel(proposal)}
            </Chip>
          )
        }
      >
        {proposal.payload.summary && (
          <p className="rz-lead rz-proposals__summary">
            {proposal.payload.summary}
          </p>
        )}
        <div className="rz-metaline">{tr("Jij kiest wat je overneemt.")}</div>
        {stale && (
          <div
            className="rz-proposals__stale"
            role="status"
            data-test="proposal-stale"
          >
            <StatusDot tone="warn" />
            <span>{tr("Dit voorstel gebruikt eerdere context.")}</span>
            <TextButton
              onClick={() =>
                launch({
                  mode: proposal.kind === "context" ? "intake" : "planning",
                  companyId: proposal.companyId,
                })
              }
            >
              {tr("Nieuw advies vragen")}
              <ArrowRight size={13} aria-hidden="true" />
            </TextButton>
          </div>
        )}
      </PageHead>
      {proposal.kind === "priorities" && (
        <div className="rz-proposals__grid">
          <Section>
            <SectionLabel as="h2">{tr("Wijzigingen")}</SectionLabel>
            {items.length ? (
              <div className="rz-proposals__changes" ref={changes}>
                {items.map((item, index) => {
                  const before =
                      tasks.findIndex((t) => t.id === item.taskId) + 1,
                    task = tasks[before - 1],
                    decision = decisions[item.taskId];
                  return (
                    <article
                      className="rz-proposals__change"
                      data-test="proposal-change"
                      data-task-id={item.taskId}
                      data-decision={decision || undefined}
                      key={item.taskId}
                    >
                      <div
                        className="rz-proposals__move"
                        role="img"
                        aria-label={
                          before
                            ? tr(
                                "Van plaats {0} naar plaats {1}",
                                before,
                                index + 1,
                              )
                            : tr("Naar plaats {0}", index + 1)
                        }
                      >
                        <span>{before || "—"}</span>
                        <ArrowRight size={12} aria-hidden="true" />
                        <strong>{index + 1}</strong>
                      </div>
                      <div className="rz-proposals__body">
                        <h3 className="rz-proposals__title">
                          {task?.title || tr("Taak niet meer beschikbaar")}
                        </h3>
                        <p className="rz-proposals__text">{item.reason}</p>
                        {item.evidence?.length > 0 && (
                          <ul
                            className="rz-proposals__sources"
                            aria-label={tr("Bronnen")}
                          >
                            {item.evidence.map((text, i) => (
                              <li
                                className="rz-proposals__source"
                                title={text}
                                key={i}
                              >
                                {text}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="rz-proposals__actions">
                        {decision ? (
                          <span className="rz-proposals__decided" tabIndex={-1}>
                            {decision === "accepted" ? (
                              <>
                                <Check size={12} aria-hidden="true" />
                                {tr("Overgenomen")}
                              </>
                            ) : (
                              tr("Afgewezen")
                            )}
                          </span>
                        ) : (
                          <>
                            {minimal ? (
                              <TextButton
                                className="rz-proposals__take"
                                disabled={stale}
                                onClick={() => decide(item.taskId, true)}
                              >
                                {tr("Overnemen")}
                              </TextButton>
                            ) : (
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={stale}
                                onClick={() => decide(item.taskId, true)}
                              >
                                {tr("Overnemen")}
                              </Button>
                            )}
                            <TextButton
                              tone="meta"
                              onClick={() => decide(item.taskId, false)}
                            >
                              {tr("Nee")}
                            </TextButton>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty inline title={tr("Geen wijzigingen in dit voorstel.")} />
            )}
          </Section>
          <aside
            className="rz-section rz-proposals__aside"
            data-test="proposal-order"
          >
            <SectionLabel as="h2">{tr("Nieuwe volgorde")}</SectionLabel>
            <ol className="rz-proposals__order">
              {order.map((t, i) => (
                <li
                  className="rz-proposals__order-row"
                  data-changed={
                    tasks.findIndex((task) => task.id === t.id) !== i
                      ? ""
                      : undefined
                  }
                  key={t.id}
                >
                  <span className="rz-proposals__rank rz-num">{i + 1}</span>
                  <span className="rz-proposals__order-title" title={t.title}>
                    {t.title}
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      )}
      {proposal.kind === "tasks" && (
        <Cards min={260} data-test="proposal-tasks">
          {proposed.map((t, i) => {
            const project = snap.projects.find((p) => p.id === t.projectId),
              done =
                t.definitionDone ||
                (t.criteria || []).map((c) => c.text).join("\n");
            return (
              <Card as="div" key={i} data-test="proposal-task">
                <div className="rz-proposals__meta">
                  {project
                    ? tr("{0} · {1} min", project.name, t.estimateMinutes)
                    : tr("{0} min", t.estimateMinutes)}
                </div>
                <h2 className="rz-proposals__title">{t.title}</h2>
                {t.description && (
                  <p className="rz-proposals__text">{t.description}</p>
                )}
                {done && (
                  <div className="rz-proposals__done">
                    <h3 className="rz-proposals__caption">{tr("Klaar als")}</h3>
                    <p className="rz-proposals__text">{done}</p>
                  </div>
                )}
              </Card>
            );
          })}
        </Cards>
      )}
      {proposal.kind === "context" && (
        <Section tight data-test="proposal-context">
          {contextFields.map((key) => (
            <div className="rz-proposals__field" key={key}>
              <h2 className="rz-proposals__key">
                {key === "product"
                  ? tr("Aanbod")
                  : key === "audience"
                    ? tr("Doelgroep")
                    : key === "stage"
                      ? tr("Fase")
                      : tr("Knelpunt")}
              </h2>
              <div className="rz-proposals__value" data-current="">
                <span className="rz-proposals__caption">{tr("Nu")}</span>
                <p className="rz-proposals__text">
                  {company?.[key] || tr("Nog niet ingevuld")}
                </p>
              </div>
              <div className="rz-proposals__value">
                <span className="rz-proposals__caption">
                  {tr("Voorgesteld")}
                </span>
                <p className="rz-proposals__text">{proposal.payload[key]}</p>
              </div>
            </div>
          ))}
          {goals.map((g, i) => (
            <div className="rz-proposals__field" key={i}>
              <h2 className="rz-proposals__key">{tr("Nieuw doel")}</h2>
              <div className="rz-proposals__value rz-proposals__value--wide">
                <p className="rz-proposals__title">{g.title}</p>
                <span className="rz-proposals__caption">
                  {g.current} → {g.target} {g.unit}
                </span>
              </div>
            </div>
          ))}
        </Section>
      )}
      <footer className="rz-proposals__foot">
        <Button
          variant="primary"
          disabled={stale || proposal.status !== "pending"}
          onClick={() => apply(true)}
        >
          {proposal.kind === "priorities"
            ? tr("Alles overnemen")
            : tr("Voorstel overnemen")}
        </Button>
        <Button
          disabled={proposal.status !== "pending"}
          onClick={() => apply(false)}
        >
          {tr("Voorstel afwijzen")}
        </Button>
        {session && (
          <Button
            variant="quiet"
            className="rz-proposals__clarify"
            iconEnd={<ArrowRight size={13} aria-hidden="true" />}
            onClick={clarify}
          >
            {tr("Vraag om toelichting")}
          </Button>
        )}
      </footer>
    </PageShell>
  );
}
