import { t as tr, locale, translateMessage } from "../shared/i18n";
import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, MessageSquareText, X } from "lucide-react";
import type { Session } from "../shared/types";
import type { SessionMemoryInput } from "../shared/memory";
import { api, useWorkbench } from "./model";
import {
  formatTime,
  sessionTitle,
  providerName,
  type Tone,
} from "./primitives";
import {
  Button,
  Field,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalFoot,
  TextButton,
  Textarea,
} from "./rz";

const sections = () =>
  [
    ["completed", tr("Gedaan"), "accent"],
    ["decisions", tr("Besluiten"), "blue"],
    ["blockers", tr("Open punten"), "warn"],
    ["nextSteps", tr("Volgende stappen"), "text2"],
  ] as const satisfies readonly (readonly [string, string, Tone])[];
const when = (value: string) =>
  new Date(value).toLocaleString(locale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
// Header line: only the time for a note of today ("20:34"), the date with it for an older one.
const whenShort = (value: string) =>
  new Date(value).toDateString() === new Date().toDateString()
    ? formatTime(value)
    : when(value);
const lines = (value: string) => value.split("\n").filter(Boolean);

export function MemoryButton({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  if (session.purpose && session.purpose !== "work") return null;
  return (
    <>
      <IconButton
        label={tr("Notities")}
        title={tr("Notities van dit gesprek")}
        data-test="memory-toggle"
        onClick={() => setOpen(true)}
      >
        <MessageSquareText size={15} />
      </IconButton>
      {open && (
        <MemoryModal sessionId={session.id} close={() => setOpen(false)} />
      )}
    </>
  );
}

export function MemoryModal({
  sessionId,
  close,
}: {
  sessionId: string;
  close: () => void;
}) {
  const {
    snap,
    run,
    refresh,
    openSession,
    launch,
    edit: editEntity,
    openTask,
  } = useWorkbench();
  const session = snap.sessions.find((s) => s.id === sessionId);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState({
    summary: "",
    completed: "",
    decisions: "",
    blockers: "",
    nextSteps: "",
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  if (!session) return null;
  const memory = session.memory;
  const title = sessionTitle(session, snap);
  const assistant = session.provider !== "shell";
  const edit = () => {
    setDraft({
      summary: memory?.summary || "",
      completed: memory?.completed.join("\n") || "",
      decisions: memory?.decisions.join("\n") || "",
      blockers: memory?.blockers.join("\n") || "",
      nextSteps: memory?.nextSteps.join("\n") || "",
    });
    setRevision(memory?.revision || 0);
    setFailure("");
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setFailure("");
    try {
      const value: SessionMemoryInput = {
        summary: draft.summary,
        completed: [],
        decisions: [],
        blockers: [],
        nextSteps: [],
      };
      for (const [key] of sections())
        value[key] = draft[key]
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      await api("session.memory.save", {
        id: sessionId,
        value,
        expectedRevision: revision,
      });
      await refresh();
      setEditing(false);
    } catch (e) {
      setFailure((e as Error).message);
      await run(refresh);
    } finally {
      setBusy(false);
    }
  };
  const asTask = (item: string) => {
    if (!memory) return;
    const existing = snap.tasks.find(
      (t) =>
        t.companyId === session.companyId &&
        t.status !== "done" &&
        t.title.trim().toLowerCase() === item.trim().toLowerCase(),
    );
    if (existing) {
      openTask(existing);
      close();
      return;
    }
    const task = snap.tasks.find((t) => t.id === session.taskId);
    const project =
      snap.projects.find((p) => p.id === task?.projectId) ||
      snap.projects.find((p) => p.companyId === session.companyId);
    if (!project) {
      setFailure(
        tr(
          "Maak eerst een project voor dit bedrijf om de notitie aan te koppelen.",
        ),
      );
      return;
    }
    editEntity("task", {
      companyId: session.companyId,
      projectId: project.id,
      goalId: task?.goalId || project.goalId,
      title: item,
      description: tr(
        "Uit notities van {0} ({1}).\n\n{2}",
        title,
        when(memory.updatedAt),
        memory.summary,
      ),
    });
    close();
  };
  const updated = !memory
    ? ""
    : memory.source === "user"
      ? tr("bijgewerkt door jou, {0}", whenShort(memory.updatedAt))
      : assistant
        ? tr(
            "bijgewerkt door {0}, {1}",
            providerName(session.provider),
            whenShort(memory.updatedAt),
          )
        : tr("bijgewerkt door de assistent, {0}", whenShort(memory.updatedAt));
  const meta = [title, updated].filter(Boolean).join(" · ");
  const resumable =
    assistant && !!session.providerSessionId && !session.agentRunning;
  return createPortal(
    <Modal
      title={tr("Notities van dit gesprek")}
      close={() => {
        if (!busy) close();
      }}
      width="notes"
      header={
        <div
          className="rz-memory__head"
          title={`${tr("Notities van dit gesprek")} · ${meta}`}
        >
          <h2 className="rz-memory__heading">
            {tr("Notities van dit gesprek")}
          </h2>
          {" · "}
          {meta}
        </div>
      }
    >
      <ModalBody className="rz-memory" data-test="memory">
        {editing ? (
          <>
            {failure && (
              <p className="rz-error rz-error--block" role="alert">
                {translateMessage(failure)}{" "}
                {tr(
                  " Je tekst blijft hieronder bewaard. Sluit bewerken om de nieuwste notitie te bekijken.",
                )}
              </p>
            )}
            <Field label={tr("Samenvatting")}>
              <Textarea
                aria-label={tr("Samenvatting")}
                value={draft.summary}
                maxLength={1200}
                rows={3}
                onChange={(e) =>
                  setDraft({ ...draft, summary: e.target.value })
                }
              />
            </Field>
            <div className="rz-memory__sections">
              {sections().map(([key, label, tone]) => {
                const parts = lines(draft[key]);
                return (
                  <section className="rz-memory__section" key={key}>
                    <h3 className="rz-memory__label">
                      <i className="rz-dot" data-tone={tone} aria-hidden />
                      <span>{label}</span>
                    </h3>
                    {parts.map((text, i) => (
                      <div className="rz-memory__edit" key={i}>
                        <Input
                          aria-label={`${label} ${i + 1}`}
                          maxLength={350}
                          value={text}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              [key]: parts
                                .map((t, j) => (i === j ? e.target.value : t))
                                .join("\n"),
                            })
                          }
                        />
                        <IconButton
                          size="xs"
                          label={tr("{0} {1} verwijderen", label, i + 1)}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              [key]: parts.filter((_, j) => j !== i).join("\n"),
                            })
                          }
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                    ))}
                    {parts.length < 6 && (
                      <Input
                        className="rz-memory__add"
                        aria-label={tr("{0} toevoegen", label)}
                        placeholder={tr("Toevoegen en Enter")}
                        maxLength={350}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.nativeEvent.isComposing &&
                            e.currentTarget.value.trim()
                          ) {
                            e.preventDefault();
                            setDraft({
                              ...draft,
                              [key]: [
                                ...parts,
                                e.currentTarget.value.trim(),
                              ].join("\n"),
                            });
                            e.currentTarget.value = "";
                          }
                        }}
                      />
                    )}
                  </section>
                );
              })}
            </div>
            <p className="rz-hint">
              {tr(
                "Maximaal 6 punten per onderdeel, 350 tekens per punt. Deze notitie wordt ook aan je assistent meegegeven.",
              )}
            </p>
          </>
        ) : memory ? (
          <>
            {session.memoryDirty && (
              <p className="rz-error rz-error--block">
                {tr(
                  "Sinds deze notitie is verder gewerkt of een nieuw bericht verstuurd. De laatste uitwisseling is mogelijk nog niet verwerkt.",
                )}
              </p>
            )}
            {failure && (
              <p className="rz-error rz-error--block" role="alert">
                {translateMessage(failure)}
              </p>
            )}
            <p className="rz-modal__summary">{memory.summary}</p>
            <div className="rz-memory__sections">
              {sections().map(([key, label, tone]) => (
                <section
                  className="rz-memory__section"
                  data-kind={key}
                  key={key}
                >
                  <h3 className="rz-memory__label">
                    <i className="rz-dot" data-tone={tone} aria-hidden />
                    <span>{label}</span>
                  </h3>
                  {memory[key].length ? (
                    <ul className="rz-memory__items">
                      {memory[key].map((item, i) => (
                        <li className="rz-memory__item" key={i}>
                          <span className="rz-memory__text">{item}</span>
                          {(key === "blockers" || key === "nextSteps") && (
                            <TextButton
                              tone="accent"
                              className="rz-memory__action"
                              onClick={() => asTask(item)}
                            >
                              {tr("Als taak")}
                            </TextButton>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rz-memory__none">{tr("Niets vastgelegd.")}</p>
                  )}
                </section>
              ))}
            </div>
          </>
        ) : (
          <div className="rz-memory__empty">
            <p className="rz-modal__summary">
              {assistant
                ? tr(
                    "Nog geen samenvatting. De assistent vult dit aan zodra er iets is besloten of opgeleverd.",
                  )
                : tr("Nog geen notities")}
            </p>
            <p className="rz-hint">
              {assistant
                ? tr(
                    "Eerdere gesprekken krijgen niet automatisch een samenvatting; bij hervatten kan de assistent die maken.",
                  )
                : tr(
                    "Hier schrijft geen assistent mee. Je kunt zelf vastleggen wat je hebt gedaan.",
                  )}
            </p>
          </div>
        )}
        {editing ? (
          <ModalFoot className="rz-memory__foot">
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {tr("Annuleren")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !draft.summary.trim()}
              onClick={() => void save()}
            >
              {busy ? tr("Opslaan…") : tr("Notities opslaan")}
            </Button>
          </ModalFoot>
        ) : (
          <ModalFoot
            className="rz-memory__foot"
            left={
              <>
                {memory &&
                  assistant &&
                  tr(
                    "Bij hervatten leest de assistent deze notities als context.",
                  )}{" "}
                <TextButton
                  className="rz-memory__goto"
                  onClick={() => {
                    openSession(session);
                    close();
                  }}
                >
                  {tr("Gesprek bekijken")}
                  <ArrowRight size={12} aria-hidden />
                </TextButton>
              </>
            }
          >
            <Button onClick={edit}>
              {memory ? tr("Bewerken") : tr("Notitie schrijven")}
            </Button>
            {resumable && (
              <Button
                variant="primary"
                onClick={() => {
                  launch({
                    companyId: session.companyId,
                    taskId: session.taskId || undefined,
                    mode: session.mode,
                    resume: session,
                  });
                  close();
                }}
              >
                {memory
                  ? tr("Hervatten met deze notities")
                  : tr("Gesprek hervatten")}
              </Button>
            )}
          </ModalFoot>
        )}
      </ModalBody>
    </Modal>,
    document.body,
  );
}
