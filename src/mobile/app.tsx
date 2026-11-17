import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import type { ChatItem } from "../shared/agents";
import type { TerminalFrame } from "../shared/types";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/700.css";
import "./style.css";

type MobileSession = {
  id: string;
  title: string;
  company: string;
  provider: string;
  state: string;
  alive: boolean;
  agentRunning: boolean;
  transport: string;
  canSend: boolean;
  memory: string;
};
type Detail = {
  session: MobileSession;
  frame: TerminalFrame | null;
  chat: { items: ChatItem[]; more: boolean; nextSequence: number } | null;
};
class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T = any>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new RequestError(
      "Je laptop is niet bereikbaar. Controleer of hij wakker is en Tailscale verbonden is.",
      0,
    );
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new RequestError(
      "De mobiele koppeling is nog niet bereikbaar. Open Benchdesk en de mobiele koppeling op je laptop.",
      response.status,
    );
  }
  if (!response.ok)
    throw new RequestError(
      result.error || "Verbinding mislukt.",
      response.status,
    );
  return result;
}
const stateLabel = (s: MobileSession) =>
  !s.alive && s.transport === "pty"
    ? "Opgeslagen"
    : {
        idle: "Wacht op jou",
        running: "Aan het werk",
        working: "Aan het werk",
        waiting: "Wacht op jou",
        error: "Aandacht nodig",
        stopped: "Gestopt",
        exited: "Afgesloten",
      }[s.state] || (s.alive ? "Actief" : "Opgeslagen");
function Screen({ frame }: { frame: TerminalFrame }) {
  const host = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | undefined>(undefined);
  const sequence = useRef(-1);
  useEffect(() => {
    const term = new Terminal({
      cols: frame.cols,
      rows: frame.rows,
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12,
      scrollback: 1000,
      theme: {
        background: "#151b18",
        foreground: "#e6eee8",
        cursor: "#151b18",
      },
    });
    term.open(host.current!);
    terminal.current = term;
    return () => {
      terminal.current = undefined;
      term.dispose();
    };
  }, []);
  useEffect(() => {
    if (frame.sequence === sequence.current) return;
    sequence.current = frame.sequence;
    const term = terminal.current!;
    term.resize(frame.cols, frame.rows);
    term.reset();
    term.write(frame.screen);
  }, [frame]);
  return (
    <div
      className="terminal-scroll"
      aria-label="Live terminaluitvoer; horizontaal schuifbaar"
    >
      <div ref={host} />
    </div>
  );
}
function App() {
  const [paired, setPaired] = useState(false),
    [checking, setChecking] = useState(true);
  const [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState(""),
    [detailError, setDetailError] = useState("");
  const [sessions, setSessions] = useState<MobileSession[]>([]),
    [station, setStation] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]),
    [online, setOnline] = useState(false);
  const [query, setQuery] = useState(""),
    [message, setMessage] = useState(""),
    [sent, setSent] = useState("");
  const draft = useRef<{ text: string; id: string } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<{
          sessions: MobileSession[];
          station: string;
        }>("sessions");
        if (stopped) return;
        setSessions(data.sessions);
        setStation(data.station);
        setPaired(true);
        setOnline(true);
        setConnectionError("");
      } catch (e) {
        if (stopped) return;
        setOnline(false);
        if (e instanceof RequestError && e.status === 401) {
          setPaired(false);
          setSelected(null);
          setConnectionError("");
        } else setConnectionError((e as Error).message);
      } finally {
        if (!stopped) {
          setChecking(false);
          timer = setTimeout(poll, document.hidden ? 10000 : 2500);
        }
      }
    }
    void poll();
    const wake = () => {
      if (!document.hidden) {
        clearTimeout(timer); /* next regular poll resynchronizes */
      }
      setReload((v) => v + 1);
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [reload]);
  useEffect(() => {
    setDetail(null);
    setItems([]);
    setMessage("");
    setSent("");
    setError("");
    setDetailError("");
    draft.current = null;
    if (!selected || !paired) return;
    let stopped = false,
      after = 0,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<Detail>(
          `session?id=${encodeURIComponent(selected!)}&after=${after}`,
        );
        if (stopped) return;
        setDetail(data);
        setOnline(true);
        setDetailError("");
        if (data.chat) {
          const next = data.chat;
          setItems((old) => {
            const map = new Map(old.map((item) => [item.id, item]));
            next.items.forEach((item) => map.set(item.id, item));
            return [...map.values()].sort((a, b) => a.order - b.order);
          });
          after = next.nextSequence;
        }
        timer = setTimeout(
          poll,
          data.chat?.more ? 30 : document.hidden ? 10000 : 1500,
        );
      } catch (e) {
        if (stopped) return;
        setOnline(false);
        setDetailError((e as Error).message);
        timer = setTimeout(poll, 4000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected, paired]);
  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("pair", { code });
      setCode("");
      setPaired(true);
      setReload((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !message.trim()) return;
    setBusy(true);
    setError("");
    setSent("");
    // Reuse the ID after a failed/ambiguous request, including edited drafts only
    // when the text is unchanged. Never automatically retry a mutation.
    if (!draft.current || draft.current.text !== message.trim())
      draft.current = { text: message.trim(), id: crypto.randomUUID() };
    try {
      const result = await request("message", {
        id: selected,
        message: draft.current.text,
        clientMessageId: draft.current.id,
      });
      setMessage("");
      draft.current = null;
      setSent(
        result?.queued
          ? "Bericht staat klaar voor de agent."
          : "Bericht afgeleverd op je laptop.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <a href="/" className="brand" aria-label="Benchdesk start">
          <span className="mark">b.</span>benchdesk
          <span className="mobile-label">mobiel</span>
        </a>
        {paired && (
          <button
            disabled={busy}
            className="text-button"
            onClick={async () => {
              try {
                await request("logout", {});
                setPaired(false);
                setSelected(null);
                setReload((v) => v + 1);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Ontkoppel
          </button>
        )}
      </header>
      {checking ? (
        <section className="welcome">
          <p className="eyebrow">EVEN VERBINDEN</p>
          <h1>Je werk, binnen handbereik.</h1>
        </section>
      ) : !paired ? (
        <section className="welcome">
          <p className="eyebrow">JE WERK GAAT MET JE MEE</p>
          <h1>
            Dezelfde sessie.
            <br />
            Een ander scherm.
          </h1>
          <p className="intro">
            Koppel je telefoon aan Benchdesk op je laptop. Volg je agents en
            praat verder waar je gebleven was.
          </p>
          <form onSubmit={pair} className="pair-card">
            <label htmlFor="code">Koppelcode van je laptop</label>
            <input
              id="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9 ]{8,11}"
              placeholder="0000 0000"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={11}
            />
            <button className="primary" disabled={busy}>
              {busy ? "Koppelen…" : "Verbind met Benchdesk →"}
            </button>
            <p>De code is één keer te gebruiken en blijft 10 minuten geldig.</p>
          </form>
          <div className="station-note">
            <span className="dot" />
            <p>
              Je laptop voert het werk uit.
              <br />
              Houd Benchdesk open en je laptop wakker.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="connection">
            <span className={`dot ${online ? "live" : "offline"}`} />
            <span>
              {online ? "Verbonden met" : "Verbinding herstellen met"}{" "}
              <strong>{station || "je laptop"}</strong>
            </span>
          </div>
          {!selected ? (
            <section className="overview">
              <p className="eyebrow">JE WERKPLEK</p>
              <h1>Waar gaan we verder?</h1>
              <div className="list-heading">
                <h2>
                  Gesprekken <span>{sessions.length}</span>
                </h2>
                <span>{sessions.filter((s) => s.alive).length} actief</span>
              </div>
              <input
                aria-label="Zoek een gesprek"
                className="search"
                placeholder="Zoek op gesprek of bedrijf…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="sessions">
                {sessions
                  .filter((s) =>
                    `${s.title} ${s.company}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((s) => (
                    <button
                      className="session"
                      key={s.id}
                      onClick={() => setSelected(s.id)}
                    >
                      <span className={`avatar ${s.provider}`}>
                        {s.provider === "codex"
                          ? "C"
                          : s.provider === "claude"
                            ? "✳"
                            : ">_"}
                      </span>
                      <span className="session-text">
                        <span className="company">{s.company}</span>
                        <strong>{s.title}</strong>
                        <span className="state">
                          <span className={`dot ${s.alive ? "live" : ""}`} />
                          {stateLabel(s)}
                        </span>
                      </span>
                      <span className="chevron">↗</span>
                    </button>
                  ))}
              </div>
              {!sessions.length && (
                <p className="empty">
                  Nog geen gesprekken. Start er één in Benchdesk op je laptop;
                  die verschijnt hier vanzelf.
                </p>
              )}
              {!!sessions.length &&
                !sessions.some((s) =>
                  `${s.title} ${s.company}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                ) && <p className="empty">Geen gesprekken gevonden.</p>}
            </section>
          ) : (
            <section className="conversation">
              <button
                disabled={busy}
                className="back text-button"
                onClick={() => setSelected(null)}
              >
                ← Alle gesprekken
              </button>
              {!detail ? (
                <p>Gesprek ophalen…</p>
              ) : (
                <>
                  <div className="conversation-head">
                    <p className="eyebrow">{detail.session.company}</p>
                    <h1>{detail.session.title}</h1>
                    <span className="state">{stateLabel(detail.session)}</span>
                  </div>
                  {detail.session.memory && (
                    <details className="memory">
                      <summary>Waar we waren gebleven</summary>
                      <p>{detail.session.memory}</p>
                    </details>
                  )}
                  {detail.frame ? (
                    <>
                      <p className="caption">
                        Live terminal · schuif opzij voor de volledige breedte
                      </p>
                      <Screen key={selected} frame={detail.frame} />
                    </>
                  ) : (
                    <div className="chat">
                      {items.map((item) => (
                        <article
                          key={item.id}
                          className={`chat-item ${item.kind}`}
                        >
                          <span>
                            {
                              {
                                user: "Jij",
                                assistant: "Assistent",
                                tool: "Actie",
                                approval: "Toestemming nodig op laptop",
                                question: "Vraag van je agent",
                                error: "Melding",
                                notice: "Benchdesk",
                                component: "Overzicht van je agent",
                              }[item.kind]
                            }
                          </span>
                          <p>
                            {item.text ||
                              (item.status === "running" ? "Bezig…" : "")}
                          </p>
                          {["approval", "question"].includes(item.kind) &&
                            item.status === "pending" && (
                              <small>
                                Beantwoord deze vraag in Benchdesk op je laptop.
                              </small>
                            )}
                        </article>
                      ))}
                      {!items.length && (
                        <p className="empty">
                          Dit gesprek heeft nog geen berichten.
                        </p>
                      )}
                    </div>
                  )}
                  <form className="composer" onSubmit={send}>
                    <label htmlFor="message">Praat verder</label>
                    <textarea
                      id="message"
                      rows={3}
                      maxLength={30000}
                      placeholder={
                        detail.session.canSend
                          ? "Geef je agent een volgende opdracht…"
                          : "Hervat dit gesprek op je laptop."
                      }
                      disabled={!detail.session.canSend || busy}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                    <div>
                      <span>Uitvoering op je laptop</span>
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !online ||
                          !detail.session.canSend ||
                          !message.trim()
                        }
                      >
                        {busy ? "Versturen…" : "Verstuur ↑"}
                      </button>
                    </div>
                    {sent && (
                      <p role="status" className="sent">
                        {sent}
                      </p>
                    )}
                  </form>
                </>
              )}
            </section>
          )}
          <footer>
            Je laptop is je basisstation. Als hij slaapt, pauzeert de
            verbinding.
          </footer>
        </>
      )}
      {(error || detailError || connectionError) && (
        <div role="alert" className="error">
          {error || detailError || connectionError}
          <button
            className="text-button"
            aria-label="Melding sluiten"
            onClick={() => {
              setError("");
              setDetailError("");
              setConnectionError("");
            }}
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
