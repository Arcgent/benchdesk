import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  ChevronDown,
  LayoutGrid,
  Search,
  Bot,
  MessageCircle,
  Plus,
  Square,
  Check,
  Copy,
  Archive,
  Brain,
  Columns2,
} from "lucide-react";
import { locale, t as tr, translateMessage } from "../shared/i18n";
import { newAgentPolicy } from "../shared/policy";
import {
  agentInput,
  type AgentProfile,
  type AgentConversation,
  type AgentMemory,
  type ChatItem,
  type ChatRead,
} from "../shared/agents";
import { api, useWorkbench } from "./model";
import {
  Button,
  Field,
  Input,
  Textarea,
  Select,
  Modal,
  ModalBody,
  ModalFoot,
  PageShell,
  Menu,
  Tabs,
} from "./rz";
import { useDesign } from "./Theme";
import { providerName, formatDate } from "./primitives";
import {
  SessionFilesButton,
  SessionFilesPanel,
  useSessionFiles,
} from "./SessionFiles";
import type { Session } from "../shared/types";
import { GmailSessionChoice } from "./Integrations";
import { useConversations } from "./ConversationList";
import type { GmailAccess } from "../shared/integrations";
import "@fontsource-variable/inter";
import "./rustig/agents.css";
import "./rustig/agents-openbot.css";
import {
  AgentHistory,
  AgentSkills,
  AgentPermissions,
  AgentRoutines,
  AgentHandoff,
} from "./AgentCapabilities";
import { AgentAudit, AgentPolicy } from "./AgentPolicy";
import { AgentComponent } from "./AgentComponents";
import { componentSpec, type ComponentValues } from "../shared/components";

// OpenBot look: a colour orb. Only an emoji avatar is drawn on it; initials are not.
const emoji = /\p{Extended_Pictographic}/u;
export function Face({
  agent,
  size = "md",
}: {
  agent: Pick<AgentProfile, "name" | "avatar" | "color">;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <span
      className={`agent-face agent-face--${size}`}
      style={{ "--agent-color": agent.color } as CSSProperties}
      aria-hidden="true"
    >
      {emoji.test(agent.avatar) ? agent.avatar : ""}
    </span>
  );
}

const swatches = [
  "#b8593c",
  "#b8468f",
  "#2f86b8",
  "#3f9a5c",
  "#c9962c",
  "#6b7280",
];

// Roster time: clock today, weekday this week, date before that.
function when(iso: string) {
  const date = new Date(iso),
    now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(locale(), {
      hour: "2-digit",
      minute: "2-digit",
    });
  if (now.getTime() - date.getTime() < 6 * 864e5)
    return date.toLocaleDateString(locale(), { weekday: "short" });
  return date.toLocaleDateString(locale(), { day: "numeric", month: "short" });
}

function AgentForm({
  agent,
  close,
  chooseCompany,
}: {
  agent?: AgentProfile;
  close: () => void;
  chooseCompany?: boolean;
}) {
  const { snap, companyId, prefs, run, navigate, switchCompany } =
    useWorkbench();
  const [value, setValue] = useState(() =>
    agent
      ? agentInput.parse(
          Object.fromEntries(
            Object.keys(agentInput.shape).map((k) => [
              k,
              agent[k as keyof AgentProfile],
            ]),
          ),
        )
      : {
          ...agentInput.parse({
            companyId,
            name: "Agent",
            access: { policy: newAgentPolicy() },
          }),
          name: "",
        },
  );
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<typeof value>) => setValue((v) => ({ ...v, ...p }));
  return (
    <Modal
      title={agent ? tr("Agent bewerken") : tr("Nieuwe agent")}
      subtitle={tr("Geef je agent een rol, een werkwijze en een naam.")}
      close={() => {
        if (!busy) close();
      }}
      width={600}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void run(async () => {
            const id = await api<string>("agent.save", {
              value,
              id: agent?.id,
              expectedRevision: agent?.revision,
            });
            close();
            if (value.companyId !== companyId)
              switchCompany(value.companyId, `agent:${id}`);
            else navigate(`agent:${id}`);
          }).finally(() => setBusy(false));
        }}
      >
        <ModalBody className="agent-form">
          {chooseCompany && !agent && (
            <Field
              label={tr("Bedrijf")}
              hint={tr(
                "De agent werkt voor dit bedrijf: werkmap, taken en verbindingen komen daarvandaan.",
              )}
            >
              <Select
                value={value.companyId}
                onChange={(e) => patch({ companyId: e.target.value })}
              >
                {snap.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="agent-form__identity">
            <Face agent={value} size="lg" />
            <Field label={tr("Naam")}>
              <Input
                autoFocus
                required
                maxLength={100}
                value={value.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder={tr("Bijvoorbeeld LinkedIn-schrijver")}
              />
            </Field>
          </div>
          <div className="agent-form__row">
            <Field label={tr("Avatar")}>
              <Input
                value={value.avatar}
                maxLength={12}
                onChange={(e) => patch({ avatar: e.target.value })}
                placeholder={tr("Emoji (optioneel)")}
              />
            </Field>
            <div className="rz-field">
              <span className="rz-field__label" id="agent-color-label">
                {tr("Kleur")}
              </span>
              <div
                className="agent-swatches"
                role="radiogroup"
                aria-labelledby="agent-color-label"
              >
                {(swatches.includes(value.color.toLowerCase())
                  ? swatches
                  : [...swatches, value.color]
                ).map((color, n) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={value.color.toLowerCase() === color}
                    aria-label={tr("Kleur {0}", n + 1)}
                    style={{ "--agent-color": color } as CSSProperties}
                    onClick={() => patch({ color })}
                  />
                ))}
              </div>
            </div>
          </div>
          <Field label={tr("Rol")}>
            <Input
              maxLength={300}
              value={value.role}
              onChange={(e) => patch({ role: e.target.value })}
              placeholder={tr("Waar helpt deze agent je mee?")}
            />
          </Field>
          <Field label={tr("Vaste briefing")}>
            <Textarea
              rows={7}
              maxLength={12000}
              value={value.brief}
              onChange={(e) => patch({ brief: e.target.value })}
              placeholder={tr(
                "Beschrijf de opdracht, kwaliteitseisen en gewenste werkwijze.",
              )}
            />
          </Field>
          <div className="agent-form__row">
            <Field label={tr("Uitvoerder")}>
              <Select
                value={value.provider}
                onChange={(e) =>
                  patch({
                    provider: e.target.value as "claude" | "codex",
                    accountId: null,
                  })
                }
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </Select>
            </Field>
            <Field label={tr("Account")}>
              <Select
                value={value.accountId || ""}
                onChange={(e) => patch({ accountId: e.target.value || null })}
              >
                <option value="">
                  {tr("Automatisch (bedrijfsstandaard)")}
                </option>
                {prefs.accounts
                  .filter((a) => a.provider === value.provider)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          {agent && (
            <p className="agent-muted">
              {tr(
                "Wijzigingen gelden voor nieuwe gesprekken. Bestaande gesprekken behouden hun briefing en account.",
              )}
            </p>
          )}
        </ModalBody>
        <ModalFoot>
          <Button onClick={close} disabled={busy}>
            {tr("Annuleren")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !value.name.trim()}
          >
            {busy ? tr("Opslaan…") : tr("Opslaan")}
          </Button>
        </ModalFoot>
      </form>
    </Modal>
  );
}

function TaskChoice({
  agent,
  conversation,
  close,
}: {
  agent: AgentProfile;
  conversation?: AgentConversation;
  close: () => void;
}) {
  const { snap, run, navigate, info } = useWorkbench();
  const [gmail, setGmail] = useState<GmailAccess>("none");
  const tasks = snap.tasks.filter(
      (t) => t.companyId === agent.companyId && t.status !== "done",
    ),
    projects = snap.projects.filter((p) => p.companyId === agent.companyId);
  const [choice, setChoice] = useState(
      conversation ? tasks[0]?.id || "new" : "",
    ),
    [title, setTitle] = useState(""),
    [projectId, setProjectId] = useState(projects[0]?.id || ""),
    [busy, setBusy] = useState(false);
  const savedTask = useRef<string | null>(null);
  return (
    <Modal
      title={conversation ? tr("Aan taak koppelen") : tr("Nieuw gesprek")}
      subtitle={agent.name}
      close={() => {
        if (!busy) close();
      }}
      width={520}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void run(async () => {
            let taskId: string | null = choice || null;
            if (choice === "new") {
              taskId =
                savedTask.current ||
                (await api<string>("task.save", {
                  value: {
                    companyId: agent.companyId,
                    projectId,
                    title,
                    agentId: agent.id,
                    provider: agent.provider,
                  },
                }));
              savedTask.current = taskId;
            }
            if (conversation) {
              await api("chat.linkTask", { id: conversation.id, taskId });
              close();
            } else {
              const c = await api<AgentConversation>("chat.start", {
                agentId: agent.id,
                companyId: agent.companyId,
                taskId,
                gmailAccess: gmail,
              });
              close();
              navigate(`agent:${agent.id}:${c.id}`);
            }
          }).finally(() => setBusy(false));
        }}
      >
        <ModalBody className="agent-form">
          <Field label={tr("Taak")}>
            <Select
              value={choice}
              disabled={busy || !!savedTask.current}
              onChange={(e) => setChoice(e.target.value)}
            >
              {!conversation && (
                <option value="">{tr("Vrij gesprek · zonder taak")}</option>
              )}
              {projects.length > 0 && (
                <option value="new">{tr("Nieuwe taak aanmaken")}</option>
              )}
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          </Field>
          {choice === "new" && (
            <>
              <Field label={tr("Taaktitel")}>
                <Input
                  required
                  value={title}
                  disabled={!!savedTask.current}
                  maxLength={500}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label={tr("Project")}>
                <Select
                  value={projectId}
                  disabled={!!savedTask.current}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          {!conversation && !info.browser && (
            <GmailSessionChoice
              value={gmail}
              onChange={setGmail}
              disabled={busy}
            />
          )}
          <p className="agent-muted">
            {tr(
              "Je agent neemt zijn briefing en geheugen mee. Je kunt meteen je eerste bericht sturen.",
            )}
          </p>
        </ModalBody>
        <ModalFoot>
          <Button disabled={busy} onClick={close}>
            {tr("Annuleren")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              (choice === "new" && (!projectId || !title.trim())) ||
              (!!conversation && !choice)
            }
          >
            {conversation ? tr("Koppelen") : tr("Gesprek openen")}
          </Button>
        </ModalFoot>
      </form>
    </Modal>
  );
}

function Memory({ agent }: { agent: AgentProfile }) {
  const { run, navigate } = useWorkbench();
  const minimal = useDesign() === "minimaal";
  const [base, setBase] = useState(agent.memory),
    [content, setContent] = useState(agent.memory.content),
    [busy, setBusy] = useState(false);
  const dirty = content !== base.content;
  useEffect(() => {
    if (!dirty) {
      setBase(agent.memory);
      setContent(agent.memory.content);
    }
  }, [agent.memory.revision]);
  const conflict = dirty && agent.memory.revision !== base.revision;
  return (
    <section className="agent-memory">
      <div className="agent-section-heading">
        <Brain size={19} />
        <div>
          <h2>{tr("Wat deze agent heeft geleerd")}</h2>
          <p>
            {tr(
              "Voorkeuren, lessen en werkwijzen uit eerdere opdrachten. Je kunt dit geheugen zelf corrigeren.",
            )}
          </p>
        </div>
      </div>
      <Field label={tr("Agentgeheugen")}>
        <Textarea
          rows={15}
          maxLength={12000}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={tr(
            "Nog geen kennis opgeslagen. De agent vult dit aan tijdens het werk.",
          )}
        />
      </Field>
      {conflict && (
        <div role="alert" className="agent-conflict">
          <p>
            {tr(
              "Het geheugen is ondertussen gewijzigd. Kopieer je correctie en laad eerst de laatste versie.",
            )}
          </p>
          <Button
            onClick={() => {
              setBase(agent.memory);
              setContent(agent.memory.content);
            }}
          >
            {tr("Laatste versie laden")}
          </Button>
        </div>
      )}
      <div className="agent-memory__footer">
        <span className="agent-muted">
          {agent.memory.updatedAt &&
            tr("Bijgewerkt op {0}", formatDate(agent.memory.updatedAt))}
          {agent.memory.sourceConversationId && (
            <Button
              variant="quiet"
              onClick={() =>
                navigate(
                  `agent:${agent.id}:${agent.memory.sourceConversationId}`,
                )
              }
            >
              {tr("Bron bekijken")}
            </Button>
          )}
        </span>
        <Button
          // Minimaal: "Nieuw gesprek" in the page head is this screen's one green button.
          variant={minimal ? "secondary" : "primary"}
          disabled={!dirty || conflict || busy}
          onClick={() => {
            setBusy(true);
            void run(async () => {
              const memory = await api<AgentMemory>("agent.memory.save", {
                id: agent.id,
                content,
                expectedRevision: base.revision,
              });
              setBase(memory);
              setContent(memory.content);
            }).finally(() => setBusy(false));
          }}
        >
          {tr("Geheugen opslaan")}
        </Button>
      </div>
    </section>
  );
}

function Request({
  item,
  conversationId,
}: {
  item: ChatItem;
  conversationId: string;
}) {
  const { run } = useWorkbench(),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const questions = (item.detail?.questions || []) as {
    id?: string;
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
    required?: boolean;
  }[];
  const url =
    typeof item.detail?.url === "string" &&
    /^https?:\/\//i.test(item.detail.url)
      ? item.detail.url
      : null;
  const reply = (allow?: boolean) => {
    setBusy(true);
    void run(() =>
      api("chat.respond", {
        id: conversationId,
        requestId: item.id,
        ...(item.kind === "question" ? { answers, allow } : { allow }),
      }),
    ).finally(() => setBusy(false));
  };
  if (item.status !== "pending")
    return (
      <div className="agent-chat__resolved">
        <Check size={13} />
        {tr(
          item.status === "complete" ? "Vraag afgehandeld" : "Vraag vervallen",
        )}
        {item.status === "complete" && (
          <span>
            {" "}
            ·{" "}
            {item.kind === "question" && item.detail?.answers
              ? Object.values(
                  item.detail.answers as Record<string, string>,
                ).join(" · ")
              : item.detail?.source === "ask_person" && !item.detail?.decision
                ? tr("Overgeslagen")
                : tr(item.detail?.decision ? "Toegestaan" : "Geweigerd")}
          </span>
        )}
      </div>
    );
  return (
    <div className="agent-request">
      <strong>
        {item.kind === "question"
          ? tr("Je agent heeft een vraag")
          : tr("Toestemming nodig")}
      </strong>
      {item.kind === "question" &&
        item.detail?.canDecline === true &&
        item.text !== questions[0]?.question &&
        (item.detail?.source === "ask_person" ? (
          <p className="agent-request__why">{item.text}</p>
        ) : (
          <pre>{item.text}</pre>
        ))}
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          {tr("Koppeling openen")}
        </a>
      )}
      {item.kind === "question" ? (
        questions.map((q) => {
          const id = q.id || q.question;
          return (
            <Field key={id} label={q.question}>
              <div className="agent-request__options">
                {q.options?.map((o) => (
                  <Button
                    key={o.label}
                    title={o.description}
                    aria-pressed={
                      q.multiSelect
                        ? (answers[id] || "").split(", ").includes(o.label)
                        : answers[id] === o.label
                    }
                    onClick={() =>
                      setAnswers((a) => {
                        const selected = (a[id] || "")
                          .split(", ")
                          .filter(Boolean);
                        return {
                          ...a,
                          [id]: q.multiSelect
                            ? (selected.includes(o.label)
                                ? selected.filter((v) => v !== o.label)
                                : [...selected, o.label]
                              ).join(", ")
                            : o.label,
                        };
                      })
                    }
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
              <Input
                aria-label={q.question}
                value={answers[id] || ""}
                onChange={(e) =>
                  setAnswers((a) => ({ ...a, [id]: e.target.value }))
                }
              />
            </Field>
          );
        })
      ) : (
        <>
          <pre>{item.text}</pre>
          <details>
            <summary>{tr("Details")}</summary>
            <pre>{JSON.stringify(item.detail, null, 2)}</pre>
          </details>
        </>
      )}
      <div className="agent-request__actions">
        {(item.kind !== "question" || item.detail?.canDecline === true) && (
          <Button disabled={busy} onClick={() => reply(false)}>
            {item.detail?.source === "ask_person"
              ? tr("Overslaan")
              : tr("Weigeren")}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={
            busy ||
            (item.kind === "question" &&
              questions.some(
                (q) =>
                  q.required !== false &&
                  !(answers[q.id || q.question] || "").trim(),
              ))
          }
          onClick={() => reply(true)}
        >
          {item.kind === "question"
            ? tr("Antwoorden versturen")
            : tr("Toestaan")}
        </Button>
      </div>
    </div>
  );
}

function Chat({
  agent,
  conversation,
  session,
  link,
  slot,
}: {
  agent: AgentProfile;
  conversation: AgentConversation;
  session: Session;
  link: () => void;
  slot: HTMLElement | null; // the channel bar; status and actions render there
}) {
  const { run, error, snap, openTask, navigate } = useWorkbench();
  const { place } = useConversations();
  const minimal = useDesign() === "minimaal";
  const [handoff, setHandoff] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]),
    [loadError, setLoadError] = useState(""),
    [sending, setSending] = useState(false);
  const draftKey = `benchdesk-chat-draft:${conversation.id}`;
  const [draft, setDraft] = useState(
    () => localStorage.getItem(draftKey) || "",
  );
  const sendingId = useRef<{ id: string; text: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null),
    pinned = useRef(true);
  const files = useSessionFiles(session),
    busy = !!session.agentRunning || sending;
  const task = snap.tasks.find((t) => t.id === conversation.taskId);
  const merge = (incoming: ChatItem[]) =>
    setItems((previous) => {
      const all = new Map(previous.map((i) => [i.id, i]));
      for (const item of incoming)
        if ((all.get(item.id)?.sequence || 0) < item.sequence)
          all.set(item.id, item);
      return [...all.values()].sort((a, b) => a.order - b.order);
    });
  useEffect(() => {
    let canceled = false,
      loading = false,
      afterSequence = 0;
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        let more;
        do {
          const result = await api<ChatRead>("chat.read", {
            id: conversation.id,
            afterSequence,
          });
          if (canceled) return;
          merge(result.items);
          afterSequence = result.nextSequence;
          more = result.more;
        } while (more);
        setLoadError("");
      } catch (e) {
        if (!canceled) setLoadError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void read();
    const timer = setInterval(read, 3000);
    const unsubscribe = window.werk.onEvent((event) => {
      if (event.type === "chat" && event.conversationId === conversation.id)
        merge([event.item]);
      if (event.type === "changed") void read();
    });
    return () => {
      canceled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [conversation.id]);
  useEffect(() => {
    localStorage.setItem(draftKey, draft);
  }, [draft, draftKey]);
  useEffect(() => {
    if (pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [items]);
  // "/" at the start of the draft lists this agent's enabled skills; a choice names the skill in the message.
  const skills = agent.skills.filter((s) => s.enabled),
    slash =
      draft.startsWith("/") && !draft.includes("\n")
        ? draft.slice(1).toLowerCase()
        : null,
    matches =
      slash === null
        ? []
        : skills
            .filter((s) => s.name.toLowerCase().includes(slash))
            .slice(0, 8);
  const [pick, setPick] = useState(0);
  const chooseSkill = (name: string) => {
    setDraft(tr("Gebruik de skill \"{0}\". ", name));
    setPick(0);
  };
  const send = async () => {
    if (!draft.trim() || busy || agent.archived) return;
    const text = draft.trim();
    if (sendingId.current?.text !== text)
      sendingId.current = { id: crypto.randomUUID(), text };
    setSending(true);
    try {
      await api("chat.send", {
        id: conversation.id,
        message: text,
        clientMessageId: sendingId.current.id,
      });
      setDraft("");
      sendingId.current = null;
      pinned.current = true;
    } catch (e) {
      error((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      className="agent-chat"
      aria-label={tr("Gesprek met {0}", agent.name)}
    >
      {slot &&
        createPortal(
          <>
            <span
              className={`agent-chat__status${busy ? " is-busy" : ""}`}
              role="status"
            >
              {providerName(conversation.profile.provider)} ·{" "}
              {busy ? tr("Aan het werk") : tr("Klaar voor je volgende bericht")}
            </span>
            <div className="agent-chat__head-actions">
              <Button
                variant="quiet"
                icon={<Columns2 size={14} />}
                title={tr("Open dit gesprek als venster naast je andere gesprekken")}
                onClick={() => {
                  if (place(session)) navigate("workspace");
                }}
              >
                {tr("Naast elkaar openen")}
              </Button>
              <Button
                variant="quiet"
                disabled={agent.archived}
                onClick={() => setHandoff(!handoff)}
              >
                {tr("Werk overdragen")}
              </Button>
              {task ? (
                <Button variant="quiet" onClick={() => openTask(task, true)}>
                  {tr("Taak bekijken")}
                </Button>
              ) : (
                <Button variant="quiet" disabled={busy} onClick={link}>
                  {tr("Aan taak koppelen")}
                </Button>
              )}
              <SessionFilesButton state={files} />
            </div>
          </>,
          slot,
        )}
      {handoff && (
        <AgentHandoff
          agent={agent}
          conversationId={conversation.id}
          close={() => setHandoff(false)}
        />
      )}
      {files.open && <SessionFilesPanel session={session} state={files} />}
      <div
        className="agent-chat__messages"
        ref={scroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={() => {
          const el = scroll.current!;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {!items.length && !loadError && (
          <div className="agent-chat__empty">
            <Face agent={agent} size="lg" />
            <h3>{tr("Waar gaan we aan werken?")}</h3>
            <p>
              {agent.role ||
                tr("Geef je agent een opdracht of stel een vraag.")}
            </p>
          </div>
        )}
        {loadError && <p role="alert">{loadError}</p>}
        {items.map((item) => (
          <div
            key={item.id}
            className={`agent-message agent-message--${item.kind}`}
            data-status={item.status}
          >
            {["approval", "question"].includes(item.kind) ? (
              <Request item={item} conversationId={conversation.id} />
            ) : item.kind === "component" &&
              componentSpec.safeParse(item.detail?.spec).success ? (
              <AgentComponent
                spec={componentSpec.parse(item.detail!.spec)}
                status={item.status}
                values={item.detail?.values as ComponentValues | undefined}
                submit={(values) =>
                  run(() =>
                    api("chat.component.submit", {
                      id: conversation.id,
                      itemId: item.id,
                      values,
                    }),
                  )
                }
              />
            ) : item.kind === "tool" ? (
              <details>
                <summary>
                  <span
                    className={
                      item.status === "running"
                        ? "agent-tool__text is-running"
                        : "agent-tool__text"
                    }
                  >
                    {item.text}
                  </span>
                  <small>
                    {tr(
                      item.status === "running"
                        ? "Bezig"
                        : item.status === "error"
                          ? "Mislukt"
                          : item.status === "interrupted"
                            ? "Onderbroken"
                            : "Afgerond",
                    )}
                  </small>
                </summary>
                <pre>
                  {String(item.detail?.output || item.detail?.input || "")}
                </pre>
              </details>
            ) : (
              <>
                <span className="agent-message__author">
                  {item.kind === "assistant" && (
                    <Face agent={conversation.profile} size="xs" />
                  )}
                  <b>
                    {item.kind === "user"
                      ? tr("Jij")
                      : item.kind === "assistant"
                        ? conversation.profile.name
                        : tr("Benchdesk")}
                  </b>
                  {item.kind !== "user" && (
                    <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                  )}
                </span>
                <div className="agent-message__body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      img: () => null,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {["error", "notice"].includes(item.kind)
                      ? translateMessage(item.text)
                      : item.text}
                  </ReactMarkdown>
                </div>
                {item.status === "running" && <span className="agent-pulse" />}
                {item.kind === "notice" &&
                  typeof item.detail?.conversationId === "string" &&
                  typeof item.detail?.agentId === "string" && (
                    <Button
                      variant="quiet"
                      onClick={() =>
                        navigate(
                          `agent:${item.detail!.agentId}:${item.detail!.conversationId}`,
                        )
                      }
                    >
                      {tr("Gesprek openen")}
                    </Button>
                  )}
              </>
            )}
          </div>
        ))}
        {busy &&
          !items.some(
            (i) =>
              ["approval", "question"].includes(i.kind) &&
              i.status === "pending",
          ) &&
          !(
            items.at(-1)?.kind === "assistant" &&
            items.at(-1)?.status === "running"
          ) && (
            <div
              className="agent-typing"
              role="status"
              aria-label={tr("Aan het werk")}
            >
              <Face agent={conversation.profile} size="xs" />
              <span className="agent-typing__bubble" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
      </div>
      <form
        className="agent-chat__composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {slash !== null && (
          <div
            className="agent-slash"
            role="listbox"
            aria-label={tr("Skills van {0}", agent.name)}
          >
            {!matches.length && (
              <p className="agent-muted">
                {skills.length
                  ? tr("Geen skill gevonden.")
                  : tr("Deze agent heeft nog geen skills.")}
              </p>
            )}
            {matches.map((s, n) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={n === pick}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseSkill(s.name)}
              >
                <b>/{s.name}</b>
                <span>{s.trigger}</span>
              </button>
            ))}
          </div>
        )}
        <Textarea
          rows={2}
          aria-label={tr("Bericht aan je agent")}
          placeholder={
            agent.archived
              ? tr("Herstel de agent om verder te praten.")
              : tr("Bericht aan {0}…", agent.name)
          }
          value={draft}
          maxLength={30000}
          // Minimaal: the keyboard hint lives in the tooltip only (README "Copy-regels").
          title={
            minimal
              ? tr("Enter verstuurt · Shift+Enter voor een nieuwe regel")
              : undefined
          }
          disabled={agent.archived}
          onChange={(e) => {
            setDraft(e.target.value);
            setPick(0);
          }}
          onKeyDown={(e) => {
            if (matches.length && ["ArrowDown", "ArrowUp"].includes(e.key)) {
              e.preventDefault();
              setPick(
                (p) =>
                  (p + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
                  matches.length,
              );
              return;
            }
            if (
              matches.length &&
              (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
            ) {
              e.preventDefault();
              chooseSkill(matches[pick]?.name ?? matches[0].name);
              return;
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="agent-chat__composer-foot">
          {busy ? (
            <Button
              aria-label={tr("Stoppen")}
              onClick={() =>
                void run(() => api("chat.interrupt", { id: conversation.id }))
              }
              icon={<Square size={13} />}
            >
              {tr("Stoppen")}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              disabled={!draft.trim() || agent.archived}
              aria-label={tr("Bericht versturen")}
              title={minimal ? tr("Bericht versturen") : undefined}
              icon={<ArrowUp size={15} />}
            />
          )}
        </div>
      </form>
      {!minimal && (
        <p className="agent-chat__hint">
          {tr("Enter verstuurt · / voor skills · Shift+Enter voor een nieuwe regel")}
        </p>
      )}
    </section>
  );
}

// Overview composer: goes to the most recently used agent; "@name" at the start picks another one.
function AgentsHome({
  agents,
  addAgent,
  open,
  groups,
}: {
  agents: AgentProfile[];
  addAgent: () => void;
  open: (agent: AgentProfile, route: string) => void;
  groups?: { id: string; name: string; active: boolean }[];
}) {
  const { snap, error, inventory } = useWorkbench();
  const [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [pick, setPick] = useState(0);
  const active = agents.filter((a) => !a.archived);
  const recent = (snap.agentConversations || [])
    .filter((c) => active.some((a) => a.id === c.agentId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const fallback =
    active.find((a) => a.id === recent?.agentId) || active[0] || null;
  const lower = draft.toLowerCase();
  const named = [...active]
    .sort((a, b) => b.name.length - a.name.length)
    .find((a) => lower.startsWith(`@${a.name.toLowerCase()}`));
  const target = named || fallback;
  const mention = /^@[^\n]*$/.test(draft) && !named ? lower.slice(1) : null,
    suggestions =
      mention === null
        ? []
        : active
            .filter((a) => a.name.toLowerCase().includes(mention))
            .slice(0, 6);
  const choose = (a: AgentProfile) => {
    setDraft(`@${a.name} `);
    setPick(0);
  };
  const ready = (a: AgentProfile | null) =>
    !!a &&
    (!inventory ||
      !!inventory.providers.find((p) => p.name === a.provider && p.path));
  const send = async () => {
    const message = (
      named ? draft.slice(named.name.length + 1) : draft
    ).trim();
    if (!message || !target || busy || !ready(target)) return;
    setBusy(true);
    try {
      const c = await api<AgentConversation>("chat.start", {
        agentId: target.id,
        companyId: target.companyId,
        taskId: null,
        gmailAccess: "none",
      });
      await api("chat.send", {
        id: c.id,
        message,
        clientMessageId: crypto.randomUUID(),
      });
      setDraft("");
      open(target, `agent:${target.id}:${c.id}`);
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!active.length)
    return (
      <div className="agent-zero">
        <Bot size={35} strokeWidth={1.25} />
        <h2>{tr("Wie komt je helpen?")}</h2>
        <p>
          {tr(
            "Maak bijvoorbeeld een schrijver, onderzoeker of inbox-assistent. Jij bepaalt de rol en de werkwijze.",
          )}
        </p>
        <Button variant="primary" plus onClick={addAgent}>
          {tr("Nieuwe agent")}
        </Button>
      </div>
    );
  return (
    <>
      <section className="agent-home">
        <div className="agent-home__eyebrow">{tr("Agents")}</div>
        <h2>{tr("Waar gaan we aan werken?")}</h2>
        <form
          className="agent-chat__composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {suggestions.length > 0 && (
            <div
              className="agent-slash"
              role="listbox"
              aria-label={tr("Agent kiezen")}
            >
              {suggestions.map((a, n) => (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={n === pick}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(a)}
                >
                  <b>
                    <Face agent={a} size="xs" />
                    {a.name}
                  </b>
                  <span>{a.role}</span>
                </button>
              ))}
            </div>
          )}
          <Textarea
            rows={2}
            aria-label={tr("Bericht aan je agents")}
            placeholder={tr("Vraag iets")}
            value={draft}
            maxLength={30000}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setPick(0);
            }}
            onKeyDown={(e) => {
              if (
                suggestions.length &&
                ["ArrowDown", "ArrowUp"].includes(e.key)
              ) {
                e.preventDefault();
                setPick(
                  (p) =>
                    (p + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) %
                    suggestions.length,
                );
                return;
              }
              if (
                suggestions.length &&
                (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
              ) {
                e.preventDefault();
                choose(suggestions[pick] ?? suggestions[0]);
                return;
              }
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="agent-chat__composer-foot">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !draft.trim() || !ready(target)}
              aria-label={tr("Bericht versturen")}
              icon={<ArrowUp size={15} />}
            />
          </div>
        </form>
        <p className="agent-chat__hint">
          {target && !ready(target)
            ? tr("Installeer de gekozen uitvoerder om een gesprek te starten.")
            : tr("Gaat naar {0}. Typ @ om een andere agent te kiezen.", target?.name)}
        </p>
      </section>
      <section className="agent-explore" aria-label={tr("Agents verkennen")}>
        {(groups || [null]).map((g) => {
          const list = g ? agents.filter((a) => a.companyId === g.id) : agents;
          if (g && !list.length && !g.active) return null;
          return (
            <Fragment key={g?.id || "all"}>
        <h3>
          {g ? g.name : tr("Agents verkennen")}
          {g?.active && <span className="agent-company-chip">{tr("actief")}</span>}
        </h3>
        <div className="agent-grid">
          {list.map((a) => {
            const working = snap.sessions.some(
              (s) => s.agentId === a.id && s.agentRunning,
            );
            return (
              <button
                className="agent-card"
                key={a.id}
                data-archived={a.archived ? "" : undefined}
                style={{ "--agent-color": a.color } as CSSProperties}
                onClick={() => open(a, `agent:${a.id}`)}
              >
                {emoji.test(a.avatar) && (
                  <span className="agent-card__emoji" aria-hidden="true">
                    {a.avatar}
                  </span>
                )}
                <span className="agent-card__status">
                  {a.archived
                    ? tr("Gearchiveerd")
                    : working
                      ? tr("Aan het werk")
                      : ""}
                </span>
                <h2>{a.name}</h2>
                <p>{a.role || tr("Klaar voor een nieuwe opdracht")}</p>
              </button>
            );
          })}
          {(!g || g.active) && (
            <button className="agent-card-new" onClick={addAgent}>
              <Plus size={15} />
              {tr("Nieuwe agent")}
            </button>
          )}
        </div>
            </Fragment>
          );
        })}
      </section>
    </>
  );
}

// An agent conversation as a window on the canvas (Werkplek). Header actions live in the pane itself.
export function CanvasChat({ session }: { session: Session }) {
  const { snap } = useWorkbench();
  const conversation = snap.agentConversations?.find(
      (c) => c.id === session.conversationId,
    ),
    agent = snap.agents?.find((a) => a.id === conversation?.agentId);
  if (!conversation || !agent)
    return (
      <p className="agent-muted agent-canvas__missing">
        {tr("Dit gesprek is niet meer beschikbaar.")}
      </p>
    );
  return (
    <div className="ob-look agent-canvas">
      <Chat
        key={conversation.id}
        agent={agent}
        conversation={conversation}
        session={session}
        link={() => {}}
        slot={null}
      />
    </div>
  );
}

export function Agents() {
  const {
    snap,
    company,
    companyId,
    view,
    navigate,
    run,
    inventory,
    inspect,
    switchCompany,
    notice,
  } = useWorkbench();
  const [, selectedId, conversationId] = view.split(":"),
    agent = (snap.agents || []).find(
      (a) => a.id === selectedId && a.companyId === companyId,
    );
  // Company filter: "active" (default), "all", or one company id. Remembered per device.
  const [scope, setScope] = useState(() => {
    try {
      return localStorage.getItem("werk-agents-company") || "active";
    } catch {
      return "active";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("werk-agents-company", scope);
    } catch {}
  }, [scope]);
  const companies = snap.companies,
    multi = companies.length > 1,
    grouped = multi && scope === "all",
    shown = grouped
      ? companies.map((c) => c.id)
      : [
          scope !== "active" && companies.some((c) => c.id === scope)
            ? scope
            : companyId,
        ];
  const all = (snap.agents || []).filter((a) => shown.includes(a.companyId));
  // Opening another company's agent makes that company active, like opening its session or task.
  const open = (a: AgentProfile, route: string) => {
    if (a.companyId === companyId) return navigate(route);
    switchCompany(a.companyId, route);
    if (scope === a.companyId) setScope("active");
    const name = companies.find((c) => c.id === a.companyId)?.name;
    if (name) notice(tr("Gewisseld naar {0}", name));
  };
  const conversations = (snap.agentConversations || [])
    .filter((c) => c.agentId === agent?.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const conversation = conversations.find((c) => c.id === conversationId),
    session = snap.sessions.find((s) => s.id === conversation?.sessionId);
  const [tab, setTab] = useState<
      | "chats"
      | "memory"
      | "skills"
      | "routines"
      | "search"
      | "rules"
      | "log"
      | "settings"
    >("chats"),
    [form, setForm] = useState(false),
    [newAgent, setNewAgent] = useState(false),
    [newChat, setNewChat] = useState(false),
    [link, setLink] = useState(false),
    [archived, setArchived] = useState(false),
    [query, setQuery] = useState(""),
    [slot, setSlot] = useState<HTMLElement | null>(null),
    [copyTo, setCopyTo] = useState(companyId);
  const minimal = useDesign() === "minimaal";
  useEffect(() => {
    setTab("chats");
    setForm(false);
    setNewChat(false);
    setLink(false);
  }, [selectedId, conversationId, companyId]);
  useEffect(() => setCopyTo(companyId), [companyId]);
  useEffect(() => {
    if (!inventory) void inspect();
  }, [companyId]);
  const addAgent = () => {
    setNewAgent(true);
    setForm(true);
  };
  const count = (id: string) =>
    (snap.agents || []).filter(
      (a) => a.companyId === id && (archived || !a.archived),
    ).length;
  const available =
    !inventory ||
    !!inventory.providers.find((p) => p.name === agent?.provider && p.path);
  const visible = all.filter(
    (a) =>
      (archived || !a.archived || a.id === selectedId) &&
      (!query.trim() ||
        `${a.name} ${a.role}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const chatOpen = !!(agent && conversation && session && tab === "chats");
  return (
    <div className="agents-layout ob-look">
      <aside className="agent-roster" aria-label={tr("Vaste agents")}>
        <div className="agent-roster__head">
          <span>{tr("Agents")}</span>
          <button aria-label={tr("Agent toevoegen")} onClick={addAgent}>
            <Plus size={15} />
          </button>
        </div>
        <label className="agent-roster__search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label={tr("Agents zoeken")}
            placeholder={tr("Zoeken…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {multi && (
          <label className="agent-roster__company">
            <span className="rz-sr">{tr("Bedrijf filteren")}</span>
            <select
              value={
                scope === "all" || companies.some((c) => c.id === scope)
                  ? scope === companyId
                    ? "active"
                    : scope
                  : "active"
              }
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="active">
                {tr("{0} (actief)", company?.name || "")}
              </option>
              <option value="all">
                {tr("Alle bedrijven")} · {companies.reduce((n, c) => n + count(c.id), 0)}
              </option>
              {companies
                .filter((c) => c.id !== companyId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {count(c.id)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <nav aria-label={tr("Agent kiezen")}>
          {shown.map((id) => {
            const list = visible.filter((a) => a.companyId === id);
            if (grouped && !list.length && (query.trim() || id !== companyId))
              return null;
            return (
              <Fragment key={id}>
                {grouped && (
                  <div className="agent-roster__group">
                    {id === companyId && (
                      <i aria-label={tr("Actief bedrijf")} />
                    )}
                    {companies.find((c) => c.id === id)?.name}
                    <em>· {list.length}</em>
                  </div>
                )}
          {list.map((a) => {
            const active = snap.sessions.some(
              (s) => s.agentId === a.id && s.agentRunning,
            );
            const latest = (snap.agentConversations || [])
              .filter((c) => c.agentId === a.id)
              .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
            return (
              <button
                key={a.id}
                aria-current={a.id === selectedId ? "page" : undefined}
                className={active ? "is-working" : undefined}
                onClick={() =>
                  open(a, `agent:${a.id}${latest ? `:${latest.id}` : ""}`)
                }
              >
                <Face agent={a} />
                <strong>{a.name}</strong>
                {latest && (
                  <time dateTime={latest.updatedAt}>
                    {when(latest.updatedAt)}
                  </time>
                )}
                <small>
                  {a.archived
                    ? tr("Gearchiveerd")
                    : active
                      ? tr("Aan het werk…")
                      : latest
                        ? latest.title || tr("Nieuw gesprek")
                        : a.role || providerName(a.provider)}
                </small>
              </button>
            );
          })}
              </Fragment>
            );
          })}
          {!visible.length && query.trim() && (
            <p className="agent-roster__none">{tr("Geen agent gevonden.")}</p>
          )}
        </nav>
        <div className="agent-roster__foot">
          <button
            aria-current={!agent ? "page" : undefined}
            onClick={() => navigate("agents")}
          >
            <LayoutGrid size={15} />
            {tr("Alle agents")}
          </button>
          <label className="agent-roster__archive">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            {tr("Gearchiveerde agents tonen")}
          </label>
        </div>
      </aside>
      <PageShell
        width="full"
        className={
          !agent
            ? "agents-page agents-page--home"
            : chatOpen
              ? "agents-page agents-page--agent agents-page--chat"
              : "agents-page agents-page--agent"
        }
      >
        {!agent ? (
          <>
            <h1 className="rz-sr">{company?.name || tr("Agents")}</h1>
            <AgentsHome
              agents={all.filter((a) => archived || !a.archived)}
              addAgent={addAgent}
              open={open}
              groups={
                grouped
                  ? companies.map((c) => ({
                      id: c.id,
                      name: c.name,
                      active: c.id === companyId,
                    }))
                  : undefined
              }
            />
          </>
        ) : (
          <>
            <header className="agent-bar">
              <Face agent={agent} size="sm" />
              <h1>{agent.name}</h1>
              {agent.role && <span className="agent-bar__role">{agent.role}</span>}
              {multi && company && (
                <span className="agent-company-chip">{company.name}</span>
              )}
              <span className="agent-bar__grow" />
              {tab === "chats" && conversation && (
                <Menu
                  label={tr("Gesprekken")}
                  className="ob-look"
                  align="right"
                  wide
                  items={[
                    ...conversations.map((c) => ({
                      id: c.id,
                      label: c.title || tr("Nieuw gesprek"),
                      hint: `${formatDate(c.updatedAt)}${c.taskId ? ` · ${tr("Taak")}` : ""}`,
                      checked: c.id === conversation.id,
                      onSelect: () => navigate(`agent:${agent.id}:${c.id}`),
                    })),
                  ]}
                  footer={{
                    label: tr("Alle gesprekken"),
                    onSelect: () => navigate(`agent:${agent.id}`),
                  }}
                  trigger={(props) => (
                    <button
                      {...props}
                      className="agent-bar__thread"
                      aria-label={tr(
                        "Gesprek kiezen: {0}",
                        conversation.title || tr("Nieuw gesprek"),
                      )}
                    >
                      <span>{conversation.title || tr("Nieuw gesprek")}</span>
                      <ChevronDown size={13} aria-hidden="true" />
                    </button>
                  )}
                />
              )}
              <div className="agent-bar__slot" ref={setSlot} />
              <Button
                // Minimaal: with a chat open the send button is the one filled button.
                variant={minimal && chatOpen ? "secondary" : "primary"}
                plus
                onClick={() => setNewChat(true)}
                disabled={agent.archived || !available}
              >
                {tr("Nieuw gesprek")}
              </Button>
            </header>
            <Tabs
              label={tr("Agentonderdelen")}
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "chats", label: tr("Gesprekken") },
                { id: "memory", label: tr("Geheugen") },
                {
                  id: "skills",
                  label: minimal ? tr("Vaardigheden") : tr("Skills"),
                },
                {
                  id: "routines",
                  label: minimal ? tr("Terugkerend") : tr("Routines"),
                },
                { id: "search", label: tr("Zoeken") },
                { id: "rules", label: tr("Regels") },
                { id: "log", label: tr("Logboek") },
                { id: "settings", label: tr("Instellingen") },
              ]}
            />
            <div className="agent-body">
              {tab === "memory" ? (
                <Memory key={agent.id} agent={agent} />
              ) : tab === "skills" ? (
                <AgentSkills key={agent.id} agent={agent} />
              ) : tab === "routines" ? (
                <AgentRoutines key={agent.id} agent={agent} />
              ) : tab === "search" ? (
                <AgentHistory key={agent.id} agent={agent} />
              ) : tab === "rules" ? (
                <AgentPolicy key={agent.id} agent={agent} />
              ) : tab === "log" ? (
                <AgentAudit key={agent.id} agent={agent} />
              ) : tab === "settings" ? (
                <section className="agent-settings">
                  <h2>{tr("Vaste briefing")}</h2>
                  <p className="agent-brief">
                    {agent.brief || tr("Nog geen briefing ingevuld.")}
                  </p>
                  <p className="agent-muted">{providerName(agent.provider)}</p>
                  <div className="agent-settings__actions">
                    <Button onClick={() => setForm(true)}>
                      {tr("Agent bewerken")}
                    </Button>
                    <Button
                      icon={<Archive size={14} />}
                      onClick={() =>
                        void run(() =>
                          api("agent.archive", {
                            id: agent.id,
                            archived: !agent.archived,
                          }),
                        )
                      }
                    >
                      {agent.archived
                        ? tr("Agent herstellen")
                        : tr("Archiveren")}
                    </Button>
                  </div>
                  <div className="agent-copy">
                    <Field label={tr("Profiel kopiëren naar")}>
                      <Select
                        value={copyTo}
                        onChange={(e) => setCopyTo(e.target.value)}
                      >
                        {snap.companies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      icon={<Copy size={14} />}
                      onClick={() =>
                        void run(() =>
                          api("agent.copy", {
                            id: agent.id,
                            companyId: copyTo,
                          }),
                        )
                      }
                    >
                      {tr("Kopiëren")}
                    </Button>
                  </div>
                  <p className="agent-muted">
                    {tr(
                      "Een kopie krijgt een eigen geheugen en nieuwe gesprekken.",
                    )}
                  </p>
                  <AgentPermissions key={agent.id} agent={agent} />
                </section>
              ) : conversation && session ? (
                <Chat
                  key={conversation.id}
                  agent={agent}
                  conversation={conversation}
                  session={session}
                  link={() => setLink(true)}
                  slot={slot}
                />
              ) : (
                <nav className="agent-threads" aria-label={tr("Gesprekken")}>
                  {!conversations.length && (
                    <div className="agent-zero">
                      <MessageCircle size={28} />
                      <h2>{tr("Begin met een gesprek")}</h2>
                      <p>
                        {tr(
                          "Deel een opdracht, stel een vraag of werk samen aan een taak.",
                        )}
                      </p>
                    </div>
                  )}
                  {conversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => navigate(`agent:${agent.id}:${c.id}`)}
                    >
                      <span>{c.title || tr("Nieuw gesprek")}</span>
                      <small>
                        {formatDate(c.updatedAt)}
                        {c.taskId ? ` · ${tr("Taak")}` : ""}
                      </small>
                    </button>
                  ))}
                </nav>
              )}
              {!available && (
                <p role="status" className="agent-muted">
                  {tr(
                    "Installeer de gekozen uitvoerder om een gesprek te starten.",
                  )}
                </p>
              )}
            </div>
          </>
        )}
        {form && (
          <AgentForm
            agent={newAgent ? undefined : agent}
            chooseCompany={grouped}
            close={() => {
              setForm(false);
              setNewAgent(false);
            }}
          />
        )}
        {newChat && agent && (
          <TaskChoice agent={agent} close={() => setNewChat(false)} />
        )}
        {link && agent && conversation && (
          <TaskChoice
            agent={agent}
            conversation={conversation}
            close={() => setLink(false)}
          />
        )}
      </PageShell>
    </div>
  );
}
