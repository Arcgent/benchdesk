import { t as tr } from "../shared/i18n";
import { useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { api, useWorkbench } from "./model";
import type { NextActionsPayload } from "../shared/suggestions";
import { formatDate, providerName } from "./primitives";
import { Card, Cards, Section, SectionLabel, TextButton, cx } from "./rz";

export function Suggestions() {
  const { snap, companyId, launch, edit, openSession, openTask, run } =
    useWorkbench();
  const [busy, setBusy] = useState<string | null>(null);
  const proposals = snap.proposals
    .filter((p) => p.companyId === companyId && p.kind === "suggestions")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const proposal = proposals[0];
  const payload = proposal?.payload as NextActionsPayload | undefined;
  const session = snap.sessions
    .filter((s) => s.companyId === companyId && s.mode === "suggestions")
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const awaitingResult = session && session.id !== proposal?.sessionId;
  const running =
    session &&
    session.alive &&
    ["starting", "working", "waiting", "unknown"].includes(session.state);
  const hasGoals = snap.goals.some((g) => g.companyId === companyId);
  const hasProjects = snap.projects.some((p) => p.companyId === companyId);
  const generate = () => launch({ companyId, mode: "suggestions" });
  const decide = async (index: number, accept: boolean) => {
    if (!proposal || busy) return;
    setBusy(`${proposal.id}-${index}`);
    try {
      await run(
        () => api("suggestion.decide", { id: proposal.id, index, accept }),
        accept
          ? tr("Voorstel toegevoegd aan je taken.")
          : tr("Voorstel afgewezen."),
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      className="rz-today-sug"
      data-test="today-suggestions"
      aria-labelledby="suggestion-title"
    >
      <div className="rz-today-sug__head">
        <SectionLabel
          right={
            <TextButton
              tone="meta"
              disabled={!!running || !hasGoals || !hasProjects}
              onClick={generate}
            >
              {running
                ? tr("Voorstellen worden gemaakt…")
                : proposal
                  ? tr("Nieuwe voorstellen")
                  : tr("Maak drie voorstellen")}
            </TextButton>
          }
        >
          <span role="heading" aria-level={2} id="suggestion-title">
            {tr("Drie voorstellen voor je bedrijf")}
          </span>
        </SectionLabel>
        <p className="rz-today-sug__lead">
          {tr("Nieuwe taken op basis van je bedrijfsdoelen en context.")}
        </p>
      </div>
      {(!hasGoals || !hasProjects) && (
        <div className="rz-today-sug__notice">
          <span>
            {!hasProjects
              ? tr(
                  "Voeg eerst een project toe om de voorstellen aan te koppelen.",
                )
              : tr(
                  "Voeg eerst een bedrijfsdoel toe als basis voor de voorstellen.",
                )}
          </span>
          <TextButton onClick={() => edit(!hasProjects ? "project" : "goal")}>
            {!hasProjects ? tr("Project toevoegen") : tr("Doel toevoegen")}
            <ArrowUpRight size={12} aria-hidden="true" />
          </TextButton>
        </div>
      )}
      {awaitingResult && (
        <div className="rz-today-sug__notice" role="status">
          <span>
            {running
              ? session.state === "waiting"
                ? tr("Je assistent wacht op je antwoord of toestemming.")
                : tr("Je assistent leest de context en maakt drie voorstellen.")
              : tr("Dit gesprek heeft nog geen drie voorstellen opgeleverd.")}
          </span>
          <TextButton onClick={() => openSession(session)}>
            {tr("Bekijk gesprek")}
            <ArrowUpRight size={12} aria-hidden="true" />
          </TextButton>
        </div>
      )}
      {proposal && payload ? (
        <>
          <Cards min={220}>
            {payload.actions.map((action, index) => {
              const project = snap.projects.find(
                (p) => p.id === action.task.projectId,
              );
              const department = snap.departments.find(
                (d) => d.id === project?.departmentId,
              );
              const goal = snap.goals.find((g) => g.id === action.task.goalId);
              const decision = payload.decisions[index];
              const createdTask = snap.tasks.find(
                (t) => t.id === payload.createdTasks[index],
              );
              const locked = !!busy || proposal.status !== "pending";
              return (
                <Card
                  as="div"
                  role="article"
                  className={cx(
                    "rz-today-sug__card",
                    decision && "rz-today-sug__card--decided",
                  )}
                  data-test="suggestion-card"
                  key={`${proposal.id}-${index}`}
                  data-suggestion-index={index}
                >
                  <span className="rz-card__label">
                    {department?.name || tr("Zonder afdeling")} ·{" "}
                    {project?.name || tr("Project")}
                  </span>
                  <h3 className="rz-today-sug__title">{action.task.title}</h3>
                  <p className="rz-today-sug__reason">{action.reason}</p>
                  <div className="rz-today-sug__goal">
                    {tr("Doel:")}{" "}
                    <strong>
                      {goal?.title || tr("Doel niet meer beschikbaar")}
                    </strong>
                  </div>
                  <details className="rz-today-sug__details">
                    <summary>{tr("Onderbouwing en aanpak")}</summary>
                    <p>{action.task.description}</p>
                    <p>{action.task.definitionDone}</p>
                    <ul>
                      {action.evidence.map((source, i) => (
                        <li key={i}>{source}</li>
                      ))}
                    </ul>
                  </details>
                  <footer className="rz-today-sug__foot">
                    {decision ? (
                      <>
                        <span className="rz-today-sug__decision">
                          {decision === "accepted" ? (
                            <>
                              <Check size={12} aria-hidden="true" />
                              {tr("Toegevoegd")}
                            </>
                          ) : (
                            tr("Afgewezen")
                          )}
                        </span>
                        {createdTask && (
                          <TextButton
                            tone="meta"
                            onClick={() => openTask(createdTask)}
                          >
                            {tr("Open taak")}
                          </TextButton>
                        )}
                      </>
                    ) : (
                      <>
                        <TextButton
                          tone="accent"
                          disabled={locked}
                          onClick={() => void decide(index, true)}
                        >
                          {tr("Toevoegen")}
                        </TextButton>
                        <TextButton
                          tone="meta"
                          disabled={locked}
                          onClick={() => void decide(index, false)}
                        >
                          {tr("Niet relevant")}
                        </TextButton>
                      </>
                    )}
                  </footer>
                </Card>
              );
            })}
          </Cards>
          <p className="rz-today-sug__footnote">
            {tr(
              "Gemaakt door {0} · {1}. Vernieuw wanneer je doelen of context veranderen.",
              providerName(
                snap.sessions.find((s) => s.id === proposal.sessionId)
                  ?.provider || "codex",
              ),
              formatDate(proposal.createdAt),
            )}
          </p>
        </>
      ) : (
        <div className="rz-today-sug__empty">
          {tr(
            "Hier verschijnen drie AI-voorstellen. Ze blijven bewaard totdat je nieuwe laat maken. Alleen voorstellen die je toevoegt komen in je takenlijst.",
          )}
        </div>
      )}
    </Section>
  );
}
