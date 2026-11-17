import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  BookOpen,
  Check,
  MessageCircle,
  Network,
  Pencil,
  Search,
  RefreshCw,
} from "lucide-react";
import { locale, t as tr } from "../shared/i18n";
import type {
  BrainPage,
  BrainSearch,
  BrainSource,
  BrainSuggestion,
} from "../shared/brain";
import { api, useWorkbench } from "./model";
import {
  Button,
  Chip,
  Field,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalFoot,
  PageHead,
  PageShell,
  SectionLabel,
  StatusDot,
  TextButton,
  Textarea,
} from "./rz";
import { useDesign } from "./Theme";
import "./rustig/brain.css";

type PageSummary = Omit<BrainPage, "sections"> & {
  stale?: boolean;
  sections: (Omit<BrainPage["sections"][number], "body"> & {
    excerpt: string;
  })[];
};
type Overview = {
  suggestions: BrainSuggestion[];
  reviewSources?: BrainSource[];
  generation: number;
  pending: number;
  sources: number;
  pages: PageSummary[];
  log: { at: string; actor: string; pages: string[] }[];
};
const kinds = {
  company: "Bedrijf",
  project: "Project",
  topic: "Onderwerp",
  decision: "Besluit",
};
const statuses = {
  fact: "Vastgelegd",
  proposal: "Voorstel",
  decision: "Besluit",
  uncertain: "Onzeker",
  superseded: "Achterhaald",
  conflict: "Tegenstrijdig",
};
const colors = {
  company: "#7c6fe5",
  project: "#3684c7",
  topic: "#a58a28",
  decision: "#ca685e",
};

// Minimaal only: a source whose text is a flat JSON object reads as quiet "key: value" rows instead of raw JSON.
// Empty values, internal ids and bookkeeping timestamps are left out; known keys get their usual Dutch label.
// Anything nested stays raw.
const fieldLabels: Record<string, string> = {
  name: "Naam",
  title: "Titel",
  description: "Samenvatting",
  primary: "Belangrijkste doel",
  recurrence: "Herhaling",
  provider: "Uitvoerder",
  model: "Model",
  dueDate: "Deadline",
  product: "Aanbod",
  audience: "Doelgroep",
  stage: "Fase",
  bottleneck: "Knelpunt",
  status: "Status",
  unit: "Eenheid",
  current: "Huidig",
  baseline: "Startwaarde",
  target: "Doel",
  criteria: "Criteria",
  definitionDone: "Klaar als",
  kind: "Soort",
  workspacePath: "Werkmap",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readableDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) return value;
  const date = new Date(value.includes("T") ? value : value + "T12:00:00");
  if (Number.isNaN(date.getTime())) return value;
  return value.includes("T")
    ? date.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })
    : date.toLocaleDateString(locale(), { dateStyle: "medium" });
}
function sourceFields(body: string): [string, string][] | null {
  if (!body.trim().startsWith("{")) return null;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === "" || value === false) continue;
    if (key === "createdAt" || key === "updatedAt") continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      if (value.some((v) => v === null || typeof v === "object")) return null;
      rows.push([key, value.join(", ")]);
    } else if (typeof value === "object") {
      return null;
    } else if (typeof value === "string") {
      if (uuid.test(value) && /(^id|Id)$/.test(key)) continue;
      rows.push([key, readableDate(value)]);
    } else rows.push([key, value === true ? "✓" : String(value)]);
  }
  return rows.length ? rows : null;
}
function SourceBody({ body, minimal }: { body: string; minimal: boolean }) {
  const rows = minimal ? sourceFields(body) : null;
  if (!rows) return <pre>{body}</pre>;
  return (
    <dl className="brain-source-fields">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{fieldLabels[key] ? tr(fieldLabels[key]) : key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BrainGraph({
  pages,
  selected,
  select,
}: {
  pages: PageSummary[];
  selected: string;
  select: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const nodes = useMemo(() => {
    const groups = new Map<string, PageSummary[]>();
    for (const p of pages.slice(0, 120)) {
      const key = p.projectId || p.kind;
      groups.set(key, [...(groups.get(key) || []), p]);
    }
    return [...groups.values()].flatMap((group, gi) =>
      group.map((p, i) => {
        const ga = (gi / groups.size) * Math.PI * 2,
          a = (i / group.length) * Math.PI * 2;
        const radius =
          groups.size === 1
            ? Math.min(180, 80 + group.length * 12)
            : Math.min(95, 45 + group.length * 4);
        return {
          ...p,
          x:
            400 +
            Math.cos(ga) * (groups.size > 1 ? 180 : 0) +
            Math.cos(a) * radius,
          y:
            225 +
            Math.sin(ga) * (groups.size > 1 ? 115 : 0) +
            Math.sin(a) * radius,
        };
      }),
    );
  }, [pages]);
  const positions = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div className="brain-graph">
      <div className="brain-graph-controls">
        <span>{tr("Verbindingen tussen pagina’s")}</span>
        <label>
          {tr("Zoom")}{" "}
          <input
            aria-label={tr("Zoom")}
            type="range"
            min="0.5"
            max="2.5"
            step="0.1"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          {tr("Herstellen")}
        </button>
      </div>
      <svg
        viewBox="0 0 800 450"
        role="group"
        aria-label={tr("Netwerk van wikipagina’s")}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[role="button"]')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ x: e.clientX, y: e.clientY });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const scale = 800 / e.currentTarget.getBoundingClientRect().width;
          setPan((p) => ({
            x: p.x + (e.clientX - drag.x) * scale,
            y: p.y + (e.clientY - drag.y) * scale,
          }));
          setDrag({ x: e.clientX, y: e.clientY });
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        <g
          transform={`translate(${pan.x} ${pan.y}) translate(400 225) scale(${zoom}) translate(-400 -225)`}
        >
          {nodes.flatMap((n) =>
            [...new Set(n.sections.flatMap((s) => s.links))].map((id) => {
              const to = positions.get(id);
              return to ? (
                <line
                  key={`${n.id}-${id}`}
                  x1={n.x}
                  y1={n.y}
                  x2={to.x}
                  y2={to.y}
                  className="brain-edge"
                />
              ) : null;
            }),
          )}
          {nodes.map((n) => (
            <g
              key={n.id}
              role="button"
              tabIndex={0}
              aria-label={n.title}
              aria-pressed={selected === n.id}
              className="brain-node"
              onClick={() => select(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(n.id);
                }
              }}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={selected === n.id ? 11 : 7}
                fill={colors[n.kind]}
                stroke={selected === n.id ? "currentColor" : "none"}
                strokeWidth={2}
              />
              <text x={n.x} y={n.y + 24} textAnchor="middle">
                {n.title.slice(0, 25)}
              </text>
              <title>{n.title}</title>
            </g>
          ))}
        </g>
      </svg>
      {pages.length > 120 && (
        <p>
          {tr(
            "Het netwerk toont maximaal 120 pagina’s. Gebruik zoeken om te verfijnen.",
          )}
        </p>
      )}
    </div>
  );
}

function WikiSuggestion({
  suggestion,
  companyId,
  refresh,
}: {
  suggestion: BrainSuggestion;
  companyId: string;
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [source, setSource] = useState<(BrainSource & { body: string }) | null>(
    null,
  );
  const minimal = useDesign() === "minimaal";
  const decide = async (action: "accept" | "dismiss") => {
    setBusy(true);
    setFailure("");
    try {
      await api("brain.suggestion.decide", {
        companyId,
        suggestionId: suggestion.id,
        action,
        edits,
      });
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="brain-suggestion"
      data-test="wiki-suggestion"
      name={minimal ? "brain-review" : undefined}
    >
      {minimal ? (
        <summary>
          <span>
            {suggestion.value.changes.map((c) => c.title).join(" · ")}
          </span>
          <small>{tr(statuses.proposal)}</small>
        </summary>
      ) : (
        <summary>
          {suggestion.value.changes.map((c) => c.title).join(" · ")}
        </summary>
      )}
      <p className="brain-meta">
        {tr(
          "Toevoegen aan je wiki? Controleer de inhoud en bronnen. Gekoppelde wijzigingen worden samen verwerkt.",
        )}
      </p>
      {suggestion.value.changes.map((c) => (
        <section key={c.pageId}>
          <h3>{c.title}</h3>
          {c.sections.map((section) => {
            const key = `${c.pageId}:${section.id}`;
            return (
              <div className="brain-section" key={key}>
                <h4>
                  {section.title}{" "}
                  <span
                    className={
                      minimal
                        ? `brain-status brain-status-${section.status}`
                        : "brain-status"
                    }
                  >
                    {tr(statuses[section.status])}
                  </span>
                </h4>
                {editing ? (
                  <Textarea
                    aria-label={`${c.title} · ${section.title}`}
                    value={edits[key] ?? section.body}
                    maxLength={6000}
                    onChange={(e) =>
                      setEdits((v) => ({ ...v, [key]: e.target.value }))
                    }
                  />
                ) : (
                  <ReactMarkdown skipHtml components={{ img: () => null }}>
                    {edits[key] ?? section.body}
                  </ReactMarkdown>
                )}
                <div className="brain-citations">
                  <span>{tr("Bronnen")}</span>
                  {section.sources.map((id, i) => (
                    <button
                      key={id}
                      onClick={() =>
                        void api<BrainSource & { body: string }>(
                          "brain.source",
                          { companyId, sourceId: id },
                        )
                          .then(setSource)
                          .catch((e) => setFailure(e.message))
                      }
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {source && (
        <aside className="brain-source">
          <div className="brain-detail-head">
            <h3>{source.title}</h3>
            <Button
              variant={minimal ? "quiet" : undefined}
              onClick={() => setSource(null)}
            >
              {tr("Sluiten")}
            </Button>
          </div>
          <SourceBody body={source.body} minimal={minimal} />
        </aside>
      )}
      {failure && (
        <p className="rz-error" role="alert">
          {failure}
        </p>
      )}
      <div className="brain-actions">
        <Button
          variant={minimal ? "primary" : undefined}
          disabled={busy || Object.values(edits).some((v) => !v.trim())}
          onClick={() => void decide("accept")}
        >
          {!minimal && <Check size={15} />}
          {tr("Goedkeuren")}
        </Button>
        <Button
          variant={minimal ? "quiet" : undefined}
          disabled={busy}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? tr("Voorbeeld bekijken") : tr("Aanpassen")}
        </Button>
        <Button
          variant={minimal ? "quiet" : undefined}
          disabled={busy}
          onClick={() => void decide("dismiss")}
        >
          {tr("Afkeuren")}
        </Button>
      </div>
    </details>
  );
}

function SourceCandidate({
  source,
  companyId,
  refresh,
}: {
  source: BrainSource;
  companyId: string;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    truncated: boolean;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const minimal = useDesign() === "minimaal";
  const load = async () => {
    setBusy(true);
    setFailure("");
    try {
      setDraft(
        await api("brain.source.draft", { companyId, sourceId: source.id }),
      );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (action: "accept" | "dismiss") => {
    setBusy(true);
    setFailure("");
    try {
      await api("brain.source.decide", {
        companyId,
        sourceId: source.id,
        action,
        title: draft?.title,
        body: draft?.body,
      });
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="brain-suggestion"
      data-test="wiki-source-candidate"
      name={minimal ? "brain-review" : undefined}
      onToggle={(e) => {
        if (e.currentTarget.open && !draft && !busy) void load();
      }}
    >
      <summary>
        <span>{source.title}</span>
        <small>
          {tr("Bronconcept")} ·{" "}
          {tr(
            source.kind === "session"
              ? "Gespreksnotities"
              : source.kind === "project"
                ? "Project"
                : source.kind === "company"
                  ? "Bedrijf"
                  : "Bron",
          )}
        </small>
      </summary>
      <p className="brain-meta">
        {tr(
          "Dit is een concept uit een bron. Controleer of pas de inhoud aan voordat je het als wiki-artikel goedkeurt.",
        )}
      </p>
      {busy && !draft && !failure && (
        <p className="brain-meta" role="status">
          {tr("Wiki-concept laden…")}
        </p>
      )}
      {draft && (
        <>
          {editing ? (
            <>
              <Field label={tr("Artikeltitel")}>
                <Input
                  aria-label={tr("Artikeltitel")}
                  maxLength={160}
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </Field>
              <Textarea
                aria-label={tr("Artikelinhoud")}
                maxLength={6000}
                rows={10}
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </>
          ) : (
            <section
              className="brain-draft-preview"
              aria-label={tr("Voorgestelde wiki-inhoud")}
            >
              <span className="brain-draft-label">
                {tr("Dit wordt toegevoegd als nieuwe wikipagina")}
              </span>
              <h3>{draft.title}</h3>
              <div className="brain-section">
                <ReactMarkdown skipHtml components={{ img: () => null }}>
                  {draft.body ||
                    tr(
                      "Deze bron bevat nog geen artikeltekst. Voeg tekst toe via Aanpassen.",
                    )}
                </ReactMarkdown>
              </div>
            </section>
          )}
          {draft.truncated && (
            <p className="brain-meta">
              {tr(
                "Het concept is ingekort. Bekijk de volledige bron voordat je goedkeurt.",
              )}
            </p>
          )}
        </>
      )}
      {raw !== null && (
        <aside className="brain-source">
          {minimal && <span className="brain-draft-label">{tr("Bron")}</span>}
          <SourceBody body={raw} minimal={minimal} />
        </aside>
      )}
      {failure && (
        <p className="rz-error" role="alert">
          {failure}
        </p>
      )}
      <div className="brain-actions">
        <Button
          variant={minimal ? "primary" : undefined}
          disabled={busy || !draft?.title.trim() || !draft.body.trim()}
          onClick={() => void decide("accept")}
        >
          {!minimal && <Check size={15} />}
          {tr("Goedkeuren")}
        </Button>
        <Button
          variant={minimal ? "quiet" : undefined}
          disabled={busy || !draft}
          onClick={() => setEditing(!editing)}
        >
          {tr(editing ? "Voorbeeld bekijken" : "Aanpassen")}
        </Button>
        <Button
          variant={minimal ? "quiet" : undefined}
          disabled={busy}
          onClick={() => void decide("dismiss")}
        >
          {tr("Afkeuren")}
        </Button>
        <Button
          variant={minimal ? "quiet" : undefined}
          disabled={busy}
          onClick={() => {
            if (raw !== null) {
              setRaw(null);
              return;
            }
            void api<BrainSource & { body: string }>("brain.source", {
              companyId,
              sourceId: source.id,
            })
              .then((v) => setRaw(v.body))
              .catch((e) => setFailure(e.message));
          }}
        >
          {tr(raw === null ? "Bron bekijken" : "Bron sluiten")}
        </Button>
        {failure && !draft && (
          <Button
            variant={minimal ? "quiet" : undefined}
            disabled={busy}
            onClick={() => void load()}
          >
            {tr("Opnieuw proberen")}
          </Button>
        )}
      </div>
    </details>
  );
}

export function Brain() {
  const { companyId, launch, error, snap } = useWorkbench();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState<BrainPage | null>(null);
  const [revision, setRevision] = useState<number | undefined>();
  const [source, setSource] = useState<(BrainSource & { body: string }) | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BrainSearch | null>(null);
  const [kind, setKind] = useState("");
  const [network, setNetwork] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [reviewQuery, setReviewQuery] = useState("");
  const [reviewFilter, setReviewFilter] = useState("all");
  // Minimaal: the review list opens with a few rows, and its own search sits behind an icon.
  const minimal = useDesign() === "minimaal";
  const [reviewAll, setReviewAll] = useState(false);
  const [reviewSearch, setReviewSearch] = useState(false);
  // Minimaal: Escape in the review search collapses it; keyboard focus goes back to the search toggle.
  const reviewSearchToggle = useRef<HTMLButtonElement>(null),
    refocusReviewSearch = useRef(false);
  useEffect(() => {
    if (reviewSearch || !refocusReviewSearch.current) return;
    refocusReviewSearch.current = false;
    reviewSearchToggle.current?.focus();
  }, [reviewSearch]);
  useEffect(() => {
    setOverview(null);
    setSelected("");
    setResults(null);
    setQuery("");
    setReviewQuery("");
    setReviewFilter("all");
    setEditing("");
    setRevision(undefined);
  }, [companyId]);
  useEffect(() => {
    let active = true;
    void api<Overview>("brain.overview", { companyId })
      .then((v) => {
        if (active) {
          setOverview(v);
          setFailure("");
        }
      })
      .catch((e) => {
        if (active) setFailure(e.message);
      });
    return () => {
      active = false;
    };
  }, [companyId, refreshKey, snap]);
  useEffect(() => {
    let active = true;
    setPage(null);
    setSource(null);
    if (selected)
      void api<BrainPage>("brain.page", {
        companyId,
        pageId: selected,
        revision,
      })
        .then((v) => {
          if (active) setPage(v);
        })
        .catch((e) => {
          if (active) setFailure(e.message);
        });
    return () => {
      active = false;
    };
  }, [companyId, selected, revision, refreshKey, overview?.generation]);
  const choose = (id: string) => {
    setSelected(id);
    setRevision(undefined);
    setEditing("");
  };
  const search = async () => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      setResults(await api<BrainSearch>("brain.search", { companyId, query }));
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const correct = async () => {
    if (!page) return;
    setBusy(true);
    try {
      await api("brain.correct", {
        companyId,
        pageId: page.id,
        sectionId: editing,
        expectedRevision: page.revision,
        body: draft,
      });
      setEditing("");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const readPage = () => {
    setRevision(undefined);
    setEditing("");
  };
  const editPage = async () => {
    if (!page) return;
    setBusy(true);
    setFailure("");
    try {
      const latest =
        current && page.revision !== current.revision
          ? await api<BrainPage>("brain.page", {
              companyId,
              pageId: page.id,
            })
          : page;
      const section = latest.sections[0];
      if (!section) return;
      setRevision(undefined);
      setPage(latest);
      setEditing(section.id);
      setDraft(section.body);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pages = (overview?.pages || []).filter(
    (p) =>
      (!kind || kind === p.kind) &&
      (!results || results.hits.some((h) => h.pageId === p.id)),
  );
  const current = overview?.pages.find((p) => p.id === selected);
  const reviewSuggestions =
    reviewFilter !== "sources"
      ? overview?.suggestions.filter((s) =>
          s.value.changes.some((c) =>
            c.title
              .toLocaleLowerCase()
              .includes(reviewQuery.toLocaleLowerCase()),
          ),
        )
      : undefined;
  const reviewSources =
    reviewFilter !== "suggestions"
      ? overview?.reviewSources?.filter((s) =>
          s.title.toLocaleLowerCase().includes(reviewQuery.toLocaleLowerCase()),
        )
      : undefined;
  const reviewFirst = 6;
  const reviewTotal =
    (reviewSuggestions?.length || 0) + (reviewSources?.length || 0);
  const reviewCut = minimal && !reviewAll && !reviewQuery;
  const shownSuggestions = reviewCut
    ? reviewSuggestions?.slice(0, reviewFirst)
    : reviewSuggestions;
  const shownSources = reviewCut
    ? reviewSources?.slice(
        0,
        Math.max(0, reviewFirst - (reviewSuggestions?.length || 0)),
      )
    : reviewSources;
  const reviewFilters: Record<string, string> = {
    all: "Alles",
    suggestions: "Uitgewerkte voorstellen",
    sources: "Bronconcepten",
  };
  const revisions = current?.revision || page?.revision || 0;
  const counts = tr(
    "{0} pagina’s · {1} bronnen · {2} te verwerken",
    overview?.pages.length || 0,
    overview?.sources || 0,
    overview?.pending || 0,
  );
  const kindSelect = (
    <select
      aria-label={tr("Paginatype")}
      value={kind}
      onChange={(e) => setKind(e.target.value)}
    >
      <option value="">{tr("Alle typen")}</option>
      {Object.entries(kinds).map(([id, label]) => (
        <option value={id} key={id}>
          {tr(label)}
        </option>
      ))}
    </select>
  );
  const historySelect = page && (
    <select
      aria-label={tr("Versiegeschiedenis")}
      value={revision || current?.revision || page.revision}
      onChange={(e) => {
        setRevision(Number(e.target.value));
        setEditing("");
      }}
    >
      {Array.from({ length: revisions }, (_, i) => i + 1)
        .reverse()
        .map((n) => (
          <option value={n} key={n}>
            {tr("Versie")} {n}
            {n === current?.revision ? ` · ${tr("Actueel")}` : ""}
          </option>
        ))}
    </select>
  );
  const searchInfo = results
    ? [
        results.engine === "jev"
          ? tr("Geselecteerd met Jev")
          : tr("Lokale zoekresultaten"),
        `${results.elapsedMs} ms`,
        results.cached ? tr("Uit cache") : "",
        results.fallback ? tr(results.fallback) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  return (
    <PageShell width="wide" className="brain-page" data-test="brain-page">
      <PageHead
        title={tr("Bedrijfsbrein")}
        meta={
          minimal ? counts : tr("Kennis uit je werk, met bronnen en verbanden.")
        }
        actions={
          minimal && (
            <>
              <Button
                variant="quiet"
                icon={network ? <BookOpen size={14} /> : <Network size={14} />}
                onClick={() => setNetwork((v) => !v)}
                aria-pressed={network}
              >
                {network ? tr("Pagina’s") : tr("Netwerk")}
              </Button>
              <Button
                variant="ghost"
                icon={<RefreshCw size={14} />}
                onClick={() =>
                  launch({ companyId, mode: "work", brainIntent: "update" })
                }
              >
                {tr("Wiki bijwerken")}
              </Button>
            </>
          )
        }
      />
      {minimal ? (
        <form
          className="brain-search"
          role="search"
          title={searchInfo}
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <Input
            aria-label={tr("Zoek in het bedrijfsbrein")}
            placeholder={tr("Zoek een onderwerp of besluit…")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) setResults(null);
            }}
          />
          <IconButton
            type="submit"
            size="sm"
            label={tr("Zoeken")}
            disabled={busy}
            className="brain-search__go"
          >
            <Search size={15} />
          </IconButton>
        </form>
      ) : (
        <div className="brain-toolbar">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input
              aria-label={tr("Zoek in het bedrijfsbrein")}
              placeholder={tr("Zoek een onderwerp of besluit…")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value) setResults(null);
              }}
            />
            <Button disabled={busy} type="submit">
              <Search size={15} />
              {tr("Zoeken")}
            </Button>
          </form>
          <Button onClick={() => setNetwork((v) => !v)} aria-pressed={network}>
            {network ? <BookOpen size={15} /> : <Network size={15} />}
            {network ? tr("Pagina’s") : tr("Netwerk")}
          </Button>
          <Button
            onClick={() =>
              launch({ companyId, mode: "work", brainIntent: "update" })
            }
          >
            <RefreshCw size={15} />
            {tr("Wiki bijwerken")}
          </Button>
        </div>
      )}
      {!minimal && <p className="brain-meta">{counts}</p>}
      {
        <section
          className="brain-suggestions"
          aria-label={tr("Wikivoorstellen")}
        >
          {minimal ? (
            <SectionLabel
              right={
                <>
                  {reviewSearch || reviewQuery ? (
                    <Input
                      className="brain-review-search"
                      autoFocus={!reviewQuery}
                      aria-label={tr("Zoek in beoordelingslijst")}
                      placeholder={tr("Zoek in beoordelingslijst")}
                      value={reviewQuery}
                      onChange={(e) => setReviewQuery(e.target.value)}
                      onBlur={() => !reviewQuery && setReviewSearch(false)}
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        setReviewQuery("");
                        setReviewSearch(false);
                        refocusReviewSearch.current = true;
                      }}
                    />
                  ) : (
                    <IconButton
                      ref={reviewSearchToggle}
                      size="sm"
                      label={tr("Zoek in beoordelingslijst")}
                      onClick={() => setReviewSearch(true)}
                    >
                      <Search size={14} />
                    </IconButton>
                  )}
                  <Chip
                    variant="quiet"
                    size="sm"
                    chevron
                    className="brain-filter"
                    control={
                      <select
                        aria-label={tr("Soort kandidaat")}
                        value={reviewFilter}
                        onChange={(e) => setReviewFilter(e.target.value)}
                      >
                        <option value="all">{tr("Alles")}</option>
                        <option value="suggestions">
                          {tr("Uitgewerkte voorstellen")}
                        </option>
                        <option value="sources">{tr("Bronconcepten")}</option>
                      </select>
                    }
                  >
                    {tr(reviewFilters[reviewFilter] || reviewFilters.all)}
                  </Chip>
                </>
              }
            >
              <span
                role="heading"
                aria-level={2}
                className="brain-suggestions__title"
                title={tr(
                  "Alle bronconcepten en nieuwe wiki-artikelen komen hier binnen. Keur ze goed, pas ze aan of keur ze af.",
                )}
              >
                {tr("Ter beoordeling")} ·{" "}
                {(overview?.suggestions.length || 0) +
                  (overview?.reviewSources?.length || 0)}
              </span>
            </SectionLabel>
          ) : (
            <>
              <h2>
                {tr("Ter beoordeling")} ·{" "}
                {(overview?.suggestions.length || 0) +
                  (overview?.reviewSources?.length || 0)}
              </h2>
              <p className="brain-meta">
                {tr(
                  "Alle bronconcepten en nieuwe wiki-artikelen komen hier binnen. Keur ze goed, pas ze aan of keur ze af.",
                )}
              </p>
              <div className="brain-review-filters">
                <Input
                  aria-label={tr("Zoek in beoordelingslijst")}
                  placeholder={tr("Zoek in beoordelingslijst")}
                  value={reviewQuery}
                  onChange={(e) => setReviewQuery(e.target.value)}
                />
                <select
                  aria-label={tr("Soort kandidaat")}
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value)}
                >
                  <option value="all">{tr("Alles")}</option>
                  <option value="suggestions">
                    {tr("Uitgewerkte voorstellen")}
                  </option>
                  <option value="sources">{tr("Bronconcepten")}</option>
                </select>
              </div>
            </>
          )}
          <div className="brain-review-list">
            {shownSuggestions?.map((suggestion) => (
              <WikiSuggestion
                key={suggestion.id}
                suggestion={suggestion}
                companyId={companyId}
                refresh={() => setRefreshKey((k) => k + 1)}
              />
            ))}
            {shownSources?.map((source) => (
              <SourceCandidate
                key={source.id}
                source={source}
                companyId={companyId}
                refresh={() => setRefreshKey((k) => k + 1)}
              />
            ))}
          </div>
          {minimal && !reviewQuery && reviewTotal > reviewFirst && (
            <TextButton
              tone="meta"
              className="brain-review-more"
              aria-expanded={reviewAll}
              onClick={() => setReviewAll((v) => !v)}
            >
              {reviewAll ? tr("Minder tonen") : tr("Alles tonen")}
            </TextButton>
          )}
          {overview &&
            !overview.suggestions.length &&
            !overview.reviewSources?.length && (
              <p className="brain-meta">
                {tr(
                  "Alles beoordeeld. Nieuwe kandidaten verschijnen automatisch in deze lijst.",
                )}
              </p>
            )}
          {overview && overview.reviewSources === undefined && (
            <p className="brain-meta" role="status">
              {tr(
                "Herstart Benchdesk om ook de beschikbare bronconcepten in deze lijst te laden.",
              )}
            </p>
          )}
        </section>
      }
      {results && minimal && results.moreAvailable && (
        <p className="brain-meta" role="status" title={searchInfo}>
          {tr("Verfijn je zoekvraag voor meer resultaten.")}
        </p>
      )}
      {results && !minimal && (
        <p className="brain-meta" role="status">
          {results.engine === "jev"
            ? tr("Geselecteerd met Jev")
            : tr("Lokale zoekresultaten")}{" "}
          · {results.elapsedMs} ms
          {results.cached ? ` · ${tr("Uit cache")}` : ""}
          {results.fallback ? ` · ${tr(results.fallback)}` : ""}
          {results.moreAvailable
            ? ` · ${tr("Verfijn je zoekvraag voor meer resultaten.")}`
            : ""}
        </p>
      )}
      {failure && (
        <p className="rz-error" role="alert">
          {failure}
        </p>
      )}
      {network && (
        <BrainGraph pages={pages} selected={selected} select={choose} />
      )}
      <div className="brain-layout">
        <aside className="brain-list" aria-label={tr("Wikipagina’s")}>
          {minimal ? (
            <Chip
              variant="quiet"
              size="sm"
              chevron
              className="brain-filter"
              control={kindSelect}
            >
              {kind in kinds
                ? tr(kinds[kind as keyof typeof kinds])
                : tr("Alle typen")}
            </Chip>
          ) : (
            kindSelect
          )}
          {pages.map((p) => (
            <button
              key={p.id}
              className="brain-list-item"
              aria-current={selected === p.id ? "page" : undefined}
              title={minimal ? `${tr("Versie")} ${p.revision}` : undefined}
              onClick={() => choose(p.id)}
            >
              {!minimal && (
                <span
                  className="brain-dot"
                  style={{ background: colors[p.kind] }}
                />
              )}
              <span>
                <strong>{p.title}</strong>
                {minimal ? (
                  <small>{tr(kinds[p.kind])}</small>
                ) : (
                  <small>
                    {tr(kinds[p.kind])} · {tr("Versie")} {p.revision}
                  </small>
                )}
              </span>
            </button>
          ))}
          {!pages.length && (
            <p>
              {results
                ? tr("Geen passende pagina’s gevonden.")
                : tr(
                    "Nog geen wikipagina’s. Werk de wiki bij om beschikbare bronnen samen te brengen.",
                  )}
            </p>
          )}
        </aside>
        <article className="brain-detail">
          {page ? (
            <>
              <div className="brain-detail-head">
                <h2>{page.title}</h2>
                <div
                  className="brain-page-actions"
                  role="group"
                  aria-label={tr("Wiki-acties")}
                >
                  {minimal && revisions > 1 && (
                    <Chip
                      variant="quiet"
                      size="sm"
                      chevron
                      className="brain-filter"
                      control={historySelect}
                    >
                      {tr("Versiegeschiedenis")}
                    </Chip>
                  )}
                  <Button
                    variant={minimal ? "quiet" : undefined}
                    disabled={busy}
                    aria-pressed={
                      !editing && page.revision === current?.revision
                    }
                    onClick={readPage}
                  >
                    <BookOpen size={15} />
                    {tr("Lezen")}
                  </Button>
                  <Button
                    variant={minimal ? "quiet" : undefined}
                    disabled={busy || !page.sections.length}
                    onClick={() => void editPage()}
                  >
                    <Pencil size={15} />
                    {tr("Aanpassen")}
                  </Button>
                  <Button
                    variant={minimal ? "quiet" : undefined}
                    disabled={busy}
                    onClick={() =>
                      launch({
                        companyId,
                        mode: "work",
                        brainIntent: "question",
                        brainPageId: page.id,
                      })
                    }
                  >
                    <MessageCircle size={15} />
                    {tr("Mee chatten")}
                  </Button>
                </div>
              </div>
              {!minimal && (
                <label className="brain-meta">
                  {tr("Versiegeschiedenis")} {historySelect}
                </label>
              )}
              {current?.stale && (
                <p className="brain-meta" role="status">
                  {tr(
                    "Bronnen zijn gewijzigd. Werk de wiki bij om deze pagina te controleren.",
                  )}
                </p>
              )}
              {page.sections.map((s) => (
                <section className="brain-section" key={s.id}>
                  <div className="brain-detail-head">
                    <h3>{s.title}</h3>
                    <span className={`brain-status brain-status-${s.status}`}>
                      {tr(statuses[s.status])}
                    </span>
                  </div>
                  {editing === s.id ? (
                    <>
                      <Textarea
                        aria-label={tr("Correctie")}
                        rows={8}
                        maxLength={6000}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <div className="brain-actions">
                        <Button
                          disabled={busy || !draft.trim()}
                          onClick={() => void correct()}
                        >
                          {tr("Correctie opslaan")}
                        </Button>
                        <Button
                          variant={minimal ? "quiet" : undefined}
                          disabled={busy}
                          onClick={() => setEditing("")}
                        >
                          {tr("Annuleren")}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <ReactMarkdown
                      skipHtml
                      components={{
                        img: () => null,
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {s.body}
                    </ReactMarkdown>
                  )}
                  <div className="brain-citations">
                    <span>{tr("Bronnen")}</span>
                    {s.sources.map((id, i) => (
                      <button
                        key={id}
                        onClick={() =>
                          void api<BrainSource & { body: string }>(
                            "brain.source",
                            { companyId, sourceId: id },
                          )
                            .then(setSource)
                            .catch((e) => error(e.message))
                        }
                      >
                        {i + 1}
                      </button>
                    ))}
                    {page.revision === current?.revision &&
                      editing !== s.id && (
                        <button
                          onClick={() => {
                            setEditing(s.id);
                            setDraft(s.body);
                          }}
                        >
                          {tr("Corrigeren")}
                        </button>
                      )}
                  </div>
                  {s.links.length > 0 && (
                    <div className="brain-related">
                      {s.links.map((id) => (
                        <button key={id} onClick={() => choose(id)}>
                          {overview?.pages.find((p) => p.id === id)?.title ||
                            id}{" "}
                          →
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              ))}
              {source && (
                <aside className="brain-source">
                  <div className="brain-detail-head">
                    <h3>{source.title}</h3>
                    <Button
                      variant={minimal ? "quiet" : undefined}
                      onClick={() => setSource(null)}
                    >
                      {tr("Sluiten")}
                    </Button>
                  </div>
                  <p className="brain-meta">
                    {minimal
                      ? readableDate(source.createdAt)
                      : source.createdAt}{" "}
                    ·{" "}
                    {source.current ? tr("Actueel") : tr("Eerdere bronversie")}
                  </p>
                  <SourceBody body={source.body} minimal={minimal} />
                </aside>
              )}
            </>
          ) : (
            <div className="brain-empty">
              <BookOpen size={32} />
              <h2>{tr("Je bedrijfskennis groeit hier")}</h2>
              <p>
                {tr(
                  "Kies een pagina of werk de wiki bij. De assistent verbindt bronnen, benoemt besluiten en houdt vragen open waar bewijs ontbreekt.",
                )}
              </p>
            </div>
          )}
        </article>
      </div>
    </PageShell>
  );
}

export function TypeSafeConnection() {
  const { companyId, company, info } = useWorkbench();
  const [status, setStatus] = useState<{
    configured: boolean;
    unlocked: boolean;
  } | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const minimal = useDesign() === "minimaal";
  useEffect(() => {
    let active = true;
    setKey("");
    setMessage("");
    setStatus(null);
    if (companyId)
      void api("typesafe.status", { companyId })
        .then((v) => {
          if (active) setStatus(v);
        })
        .catch((e) => {
          if (active) setMessage(e.message);
        });
    return () => {
      active = false;
    };
  }, [companyId]);
  const action = async (method: string) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await api(method, {
        companyId,
        ...(method === "typesafe.configure" ? { apiKey: key } : {}),
      });
      setKey("");
      setStatus(await api("typesafe.status", { companyId }));
      setMessage(result.message || tr("Opgeslagen"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!companyId) return null;
  return (
    <>
      <article
        className="rz-integrations__provider-card"
        data-connected={status?.configured ? "" : undefined}
        data-test="typesafe-connection"
      >
        <button
          type="button"
          className="rz-integrations__card-head"
          aria-label={tr("TypeSafe-instellingen")}
          disabled={info.browser || !status}
          onClick={() => setOpen(true)}
        >
          <span
            className="rz-integrations__brand rz-integrations__brand--typesafe"
            aria-hidden="true"
          >
            ✢
          </span>
          <div className="rz-integrations__identity">
            <h3 className="rz-integrations__name">TypeSafe · Jev</h3>
            <p className="rz-integrations__card-copy">
              {tr("Selecteert relevante wikipassages voor je assistent.")}
            </p>
          </div>
        </button>
        <div className="rz-integrations__card-foot">
          <span className="rz-integrations__card-state">
            <StatusDot tone={status?.configured ? "accent" : "muted"} />
            <span>
              {status?.configured
                ? tr("Verbonden voor dit bedrijf")
                : tr("Lokaal zoeken blijft beschikbaar")}
            </span>
          </span>
          <Button
            size="sm"
            variant={status?.configured || minimal ? "secondary" : "primary"}
            disabled={busy || info.browser || !status}
            onClick={() => setOpen(true)}
          >
            {status?.configured ? tr("Beheren") : tr("Verbinden")}
          </Button>
        </div>
      </article>
      {open && (
        <Modal
          title="TypeSafe · Jev"
          subtitle={company?.name}
          width="sm"
          close={() => !busy && setOpen(false)}
        >
          <ModalBody>
            <p className="rz-lead">
              {tr(
                "Selecteert relevante wikipassages voor je assistent. Alleen de zoekvraag en kandidaatfragmenten worden naar TypeSafe gestuurd.",
              )}
            </p>
            <Field label={tr("API-sleutel")}>
              <Input
                type="password"
                autoComplete="off"
                aria-label={tr("TypeSafe API-sleutel")}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <p className="rz-hint">
              {status?.configured
                ? tr("Verbonden · standaard actief voor dit bedrijf")
                : tr("Nog niet verbonden · lokaal zoeken blijft beschikbaar")}
            </p>
            {message && <p role="status">{tr(message)}</p>}
            {minimal ? (
              // One green action; testing and disconnecting are text actions on the left (as the provider modal).
              <ModalFoot
                left={
                  status?.configured && (
                    <span className="rz-integrations__foot-links">
                      <TextButton
                        disabled={busy}
                        onClick={() => void action("typesafe.test")}
                      >
                        {tr("Verbinding testen")}
                      </TextButton>
                      <TextButton
                        className="rz-integrations__danger"
                        disabled={busy}
                        onClick={() => void action("typesafe.remove")}
                      >
                        {tr("Ontkoppelen")}
                      </TextButton>
                    </span>
                  )
                }
              >
                <Button disabled={busy} onClick={() => setOpen(false)}>
                  {tr("Annuleren")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || key.trim().length < 8}
                  onClick={() => void action("typesafe.configure")}
                >
                  {tr("Opslaan")}
                </Button>
              </ModalFoot>
            ) : (
              <ModalFoot>
                {status?.configured && (
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => void action("typesafe.remove")}
                  >
                    {tr("Ontkoppelen")}
                  </Button>
                )}
                <Button
                  disabled={busy || !status?.configured}
                  onClick={() => void action("typesafe.test")}
                >
                  {tr("Verbinding testen")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || key.trim().length < 8}
                  onClick={() => void action("typesafe.configure")}
                >
                  {tr("Opslaan")}
                </Button>
              </ModalFoot>
            )}
          </ModalBody>
        </Modal>
      )}
    </>
  );
}
