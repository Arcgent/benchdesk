import { t as tr, locale, translateMessage } from "../shared/i18n";
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  Globe2,
  Loader2,
  Monitor,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  scheduleKindLabels,
  scheduleStatusLabels,
  type ScheduleKind,
  type ScheduleOverview,
  type ScheduleSource,
  type ScheduleStatus,
  type ScheduledJob,
} from "../shared/schedules";
import { shortPath } from "./primitives";
import {
  Button,
  Card,
  Cards,
  Check,
  Chip,
  Empty,
  Input,
  PageHead,
  PageShell,
  RowText,
  StatusDot,
  Tabs,
  type Tone,
} from "./rz";

type Filter = "all" | "timed" | "event" | "attention";

const timestamp = (value: string) =>
  new Date(value).toLocaleString(locale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
function next(job: ScheduledJob) {
  if (job.status === "paused") return tr("Gepauzeerd");
  if (job.status === "completed") return tr("Afgerond");
  if (job.nextRunLabel === "Verzendvenster nu open")
    return translateMessage(job.nextRunLabel);
  if (job.nextRunAt) return timestamp(job.nextRunAt);
  if (job.nextRunLabel) return translateMessage(job.nextRunLabel);
  return job.kind === "event"
    ? tr("Wacht op een gebeurtenis")
    : tr("Niet bekend");
}
// The row speaks plain words; the technical term ("Cronjob") stays in the row detail.
const kindWord = (kind: ScheduleKind) =>
  kind === "cron"
    ? tr("Vast tijdschema")
    : kind === "scheduled"
      ? tr("Terugkerend")
      : tr(scheduleKindLabels[kind]);
const jobTone = (status: ScheduleStatus): Tone =>
  status === "enabled" ? "accent" : status === "error" ? "warn" : "muted";
const sourceTone = (status: ScheduleSource["status"]): Tone =>
  status === "ok" ? "accent" : status === "error" ? "warn" : "muted";
const coverage = (status: ScheduleSource["status"]) =>
  status === "ok"
    ? tr("Volledig ingelezen")
    : status === "partial"
      ? tr("Deels ingelezen")
      : status === "error"
        ? tr("Niet gelezen")
        : tr("Nog niet ondersteund");
// Full paths never reach a label: the last two segments, the whole value in the tooltip.
const isPath = (value: string) => /^(~|\/)/.test(value);
const shortOrigin = (value: string) =>
  isPath(value) && value.split("/").filter(Boolean).length > 2
    ? shortPath(value)
    : value;
// A rhythm the source could not put into words stays visible as written there (cron or RRULE).
const isExpression = (value: string) =>
  /^[\d*/,-]+(\s+[\w*/,?#-]+){4,5}$/.test(value) || /FREQ=/.test(value);
const taskCount = (count: number) =>
  count === 1 ? tr("1 taak") : tr("{0} taken", count);

export function Schedules() {
  const [overview, setOverview] = useState<ScheduleOverview | null>(null);
  const [loading, setLoading] = useState(true),
    [scanning, setScanning] = useState(false),
    [failed, setFailed] = useState(false);
  const [search, setSearch] = useState(""),
    [source, setSource] = useState("all"),
    [filter, setFilter] = useState<Filter>("all"),
    [showSystem, setShowSystem] = useState(false);
  const scan = useCallback(async () => {
    setScanning(true);
    setFailed(false);
    try {
      setOverview(await window.werk.call<ScheduleOverview>("schedules.scan"));
    } catch {
      setFailed(true);
    } finally {
      setScanning(false);
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void window.werk
      .call<ScheduleOverview | null>("schedules.get")
      .then((value) => {
        if (!alive) return;
        setOverview(value);
        setLoading(false);
        if (
          !value ||
          Date.now() - new Date(value.inspectedAt).getTime() > 300_000
        )
          void scan();
      })
      .catch(() => {
        if (alive) void scan();
      });
    return () => {
      alive = false;
    };
  }, [scan]);
  const jobs = overview?.jobs || [],
    sources = overview?.sources || [];
  const sourceNames = new Map(
    sources.map((s) => [s.id, translateMessage(s.name)]),
  );
  const sourceOptions = sources.filter((s) => s.count > 0);
  // A source that vanished after a refresh must not leave an invisible filter behind.
  const activeSource = sourceOptions.some((s) => s.id === source)
    ? source
    : "all";
  const attention = jobs.filter((j) => j.issue || j.status === "error");
  const systemCount = jobs.filter((j) => j.system).length;
  const needle = search.toLocaleLowerCase("nl");
  const matches = (job: ScheduledJob, kind: Filter) =>
    (showSystem || !job.system) &&
    (activeSource === "all" || job.sourceId === activeSource) &&
    (kind === "all" ||
      (kind === "timed"
        ? ["cron", "scheduled", "once"].includes(job.kind)
        : kind === "attention"
          ? !!job.issue || job.status === "error"
          : job.kind === "event" || job.kind === "service")) &&
    (!needle ||
      `${job.title} ${translateMessage(job.schedule)} ${sourceNames.get(job.sourceId)}`
        .toLocaleLowerCase("nl")
        .includes(needle));
  const visible = jobs.filter((job) => matches(job, filter));
  const count = (kind: Filter) =>
    overview ? jobs.filter((job) => matches(job, kind)).length : undefined;
  const nextScheduled = jobs.find(
    (j) =>
      !j.system &&
      j.status === "enabled" &&
      j.nextRunAt &&
      new Date(j.nextRunAt).getTime() > Date.now(),
  );
  const confirmed = sources.filter((s) => s.status === "ok").length,
    incomplete = sources.length - confirmed;
  const busy = loading || (!overview && scanning);
  const unfiltered = filter === "all" && activeSource === "all" && !needle;
  const systemLabel = tr("Ook ingebouwde macOS-taken ({0})", systemCount);
  return (
    <div className="rz-schedules">
      <PageShell width="wide" data-test="schedules-page">
        <PageHead
          title={tr("Terugkerend")}
          meta={
            overview
              ? tr(
                  "{0} uit {1} · {2}",
                  taskCount(jobs.length),
                  sources.length === 1
                    ? tr("1 bron")
                    : tr("{0} bronnen", sources.length),
                  scanning
                    ? tr("bezig met ophalen")
                    : tr("gecontroleerd {0}", timestamp(overview.inspectedAt)),
                )
              : busy
                ? tr("Bronnen controleren…")
                : tr("Nog geen controle")
          }
          actions={
            <Button
              variant="ghost"
              disabled={scanning}
              onClick={() => void scan()}
              icon={
                <RefreshCw
                  size={14}
                  aria-hidden="true"
                  className={scanning ? "rz-spin" : undefined}
                />
              }
            >
              {scanning ? tr("Bronnen controleren…") : tr("Ververs overzicht")}
            </Button>
          }
        />
        {failed && (
          <p className="rz-schedules__alert" role="alert">
            <StatusDot tone="warn" />
            <span>
              {overview
                ? tr(
                    "Verversen is niet gelukt. Je vorige overzicht blijft beschikbaar.",
                  )
                : tr("Verversen is niet gelukt. Probeer het opnieuw.")}
            </span>
          </p>
        )}
        <Cards aria-live="polite">
          <Card as="div">
            <span className="rz-card__label">{tr("Gevonden taken")}</span>
            <span className="rz-figure">
              <span className="rz-figure__big rz-num">
                {overview ? jobs.length : "—"}
              </span>
            </span>
            <span className="rz-schedules__foot">
              {tr("taken en workflows uit je bronnen")}
            </span>
          </Card>
          <Card
            as="button"
            onClick={() => {
              setFilter("attention");
              setShowSystem(true);
            }}
          >
            <span className="rz-card__label">{tr("Vraagt aandacht")}</span>
            <span className="rz-figure">
              <span
                className="rz-figure__big rz-num rz-schedules__figure"
                data-tone={attention.length ? "warn" : undefined}
              >
                {overview ? attention.length : "—"}
              </span>
            </span>
            <span className="rz-schedules__foot">
              {tr("ontbrekende informatie of een fout")}
            </span>
          </Card>
          <Card as="div">
            <span className="rz-card__label">
              {tr("Eerstvolgende planning")}
            </span>
            <span className="rz-figure">
              <span className="rz-figure__big rz-num">
                {nextScheduled?.nextRunAt
                  ? timestamp(nextScheduled.nextRunAt)
                  : "—"}
              </span>
            </span>
            <span className="rz-schedules__foot">
              {nextScheduled?.title || tr("Geen toekomstig tijdstip bevestigd")}
            </span>
          </Card>
        </Cards>
        <details className="rz-schedules__sources" data-test="schedule-sources">
          <summary className="rz-row rz-row--sm rz-schedules__sources-head">
            <Globe2 size={16} aria-hidden="true" />
            <span className="rz-schedules__sources-text">
              <span className="rz-row__title">{tr("Je bronnen")}</span>
              <span className="rz-row__meta">
                {overview
                  ? tr(
                      "{0} volledig ingelezen · {1} met beperkte toegang of dekking",
                      confirmed,
                      incomplete,
                    )
                  : busy
                    ? tr("Worden gecontroleerd")
                    : tr("Nog geen controle")}
              </span>
            </span>
            <ChevronDown
              className="rz-schedules__chevron"
              size={14}
              aria-hidden="true"
            />
          </summary>
          <div className="rz-schedules__sources-body">
            {sources.length > 0 && (
              <div className="rz-schedules__source-grid">
                {sources.map((s) => (
                  <div
                    className="rz-schedules__source"
                    data-test="schedule-source"
                    key={s.id}
                  >
                    <div className="rz-schedules__source-head">
                      <StatusDot tone={sourceTone(s.status)} />
                      <h3 className="rz-schedules__source-name">
                        {translateMessage(s.name)}
                      </h3>
                      <small className="rz-schedules__source-state">
                        {[taskCount(s.count), coverage(s.status)].join(" · ")}
                      </small>
                    </div>
                    <p className="rz-schedules__source-message">
                      {translateMessage(s.message) || tr("Bron gecontroleerd.")}
                    </p>
                    {s.location && (
                      <span
                        className="rz-schedules__source-location rz-mono"
                        title={
                          isPath(s.location)
                            ? translateMessage(s.location)
                            : undefined
                        }
                      >
                        {shortOrigin(translateMessage(s.location))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="rz-schedules__note">
              {tr(
                "Een niet-uitgelezen bron kan nog meer taken bevatten. De getoonde aantallen zijn geen bevestiging dat alle diensten volledig zijn gecontroleerd.",
              )}
            </p>
          </div>
        </details>
        <section className="rz-schedules__list">
          <div className="rz-tabbar rz-schedules__controls">
            <Tabs<Filter>
              semantics="buttons"
              label={tr("Soort terugkerende taak")}
              value={filter}
              onChange={setFilter}
              tabs={[
                { id: "all", label: tr("Alles"), count: count("all") },
                {
                  id: "timed",
                  label: tr("Op tijd"),
                  count: count("timed"),
                  title: tr("Taken met een vaste planning"),
                },
                {
                  id: "event",
                  label: tr("Op gebeurtenis"),
                  count: count("event"),
                  title: tr(
                    "Taken die starten na een gebeurtenis of op de achtergrond draaien",
                  ),
                },
                {
                  id: "attention",
                  label: tr("Aandacht"),
                  count: count("attention"),
                  title: tr("Taken met ontbrekende informatie of een fout"),
                },
              ]}
            />
            <div className="rz-schedules__tools">
              <label className="rz-schedules__search">
                <Search size={14} aria-hidden="true" />
                <Input
                  bare
                  aria-label={tr("Zoek een terugkerende taak")}
                  placeholder={tr("Zoek een taak…")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <Chip
                size="sm"
                chevron
                className="rz-schedules__source-filter"
                data-active={activeSource === "all" ? undefined : ""}
                control={
                  <select
                    aria-label={tr("Filter op bron")}
                    value={activeSource}
                    onChange={(e) => setSource(e.target.value)}
                  >
                    <option value="all">{tr("Alle bronnen")}</option>
                    {sourceOptions.map((s) => (
                      <option value={s.id} key={s.id}>
                        {translateMessage(s.name)}
                      </option>
                    ))}
                  </select>
                }
              >
                {activeSource === "all"
                  ? tr("Alle bronnen")
                  : sourceNames.get(activeSource)}
              </Chip>
            </div>
          </div>
          <div className="rz-schedules__caption">
            <span>
              {visible.length === 1
                ? tr("1 taak zichtbaar")
                : tr("{0} taken zichtbaar", visible.length)}
            </span>
            <span className="rz-schedules__system">
              <Check
                size="xs"
                checked={showSystem}
                onChange={setShowSystem}
                label={systemLabel}
              />
              <span
                aria-hidden="true"
                onClick={() => setShowSystem((value) => !value)}
              >
                {systemLabel}
              </span>
            </span>
          </div>
          {busy ? (
            <Empty
              className="rz-schedules__empty"
              icon={<Loader2 size={16} className="rz-spin" />}
              title={tr("Je planningen ophalen")}
            >
              {tr(
                "De lokale taken en gekoppelde diensten worden gecontroleerd.",
              )}
            </Empty>
          ) : !overview ? (
            <Empty
              className="rz-schedules__empty"
              icon={<CalendarClock size={22} />}
              title={tr("Nog geen overzicht")}
            >
              {tr(
                "Je bronnen zijn nog niet gecontroleerd. Ververs het overzicht om het opnieuw te proberen.",
              )}
            </Empty>
          ) : !visible.length ? (
            !jobs.length ? (
              <Empty
                className="rz-schedules__empty"
                icon={<CalendarClock size={22} />}
                title={tr("Nog geen taken gevonden")}
              >
                {incomplete
                  ? tr(
                      "Niet elke bron kon volledig worden gelezen. Bekijk Je bronnen om te zien wat is gecontroleerd.",
                    )
                  : tr("Bekijk Je bronnen om te zien wat is gecontroleerd.")}
              </Empty>
            ) : unfiltered && !showSystem ? (
              <Empty
                className="rz-schedules__empty"
                icon={<CalendarClock size={22} />}
                title={tr("Alleen ingebouwde macOS-taken gevonden")}
                action={
                  <Button onClick={() => setShowSystem(true)}>
                    {tr("Ingebouwde taken tonen")}
                  </Button>
                }
              >
                {tr(
                  "Je eigen bronnen bevatten nog geen terugkerende taken. De taken van macOS zelf staan standaard uit.",
                )}
              </Empty>
            ) : (
              <Empty
                className="rz-schedules__empty"
                icon={<CalendarClock size={22} />}
                title={tr("Geen taken met deze filters")}
              >
                {tr("Pas je zoekopdracht of bronfilter aan.")}
              </Empty>
            )
          ) : (
            <div className="rz-schedules__table">
              <div className="rz-colhead rz-schedules__cols">
                <span className="rz-schedules__col-task">
                  {tr("Taak en herkomst")}
                </span>
                <span>{tr("Ritme")}</span>
                <span>{tr("Volgend moment")}</span>
                <span>{tr("Status")}</span>
                <span />
              </div>
              {visible.map((job) => {
                const rhythm = translateMessage(job.schedule);
                return (
                  <details
                    key={job.id}
                    className="rz-schedules__job"
                    data-test="schedule-row"
                  >
                    <summary className="rz-row rz-row--md rz-schedules__cols">
                      <span className="rz-schedules__task">
                        {job.kind === "cron" || job.kind === "service" ? (
                          <Monitor size={17} aria-hidden="true" />
                        ) : (
                          <CalendarClock size={17} aria-hidden="true" />
                        )}
                        <RowText
                          wrap
                          title={job.title}
                          meta={[
                            sourceNames.get(job.sourceId) ||
                              tr("Onbekende bron"),
                            kindWord(job.kind),
                          ].join(" · ")}
                        />
                      </span>
                      <span
                        className={
                          isExpression(rhythm)
                            ? "rz-schedules__rhythm rz-mono"
                            : "rz-schedules__rhythm"
                        }
                        title={
                          isExpression(rhythm)
                            ? tr("Het tijdschema zoals het in de bron staat")
                            : undefined
                        }
                      >
                        {rhythm}
                      </span>
                      <span className="rz-row__text">
                        <span className="rz-schedules__when">{next(job)}</span>
                        {job.nextRunAt && (
                          <span className="rz-row__meta">
                            {translateMessage(job.nextRunLabel || "") ||
                              tr("Volgens het schema")}
                          </span>
                        )}
                      </span>
                      <StatusDot
                        tone={jobTone(job.status)}
                        label={tr(scheduleStatusLabels[job.status])}
                      />
                      <ChevronDown
                        className="rz-schedules__chevron"
                        size={14}
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="rz-schedules__detail">
                      {job.description && (
                        <p className="rz-schedules__description">
                          {translateMessage(job.description)}
                        </p>
                      )}
                      {job.issue && (
                        <p className="rz-schedules__issue">
                          <StatusDot tone="warn" />
                          <span>{translateMessage(job.issue)}</span>
                        </p>
                      )}
                      <dl className="rz-schedules__facts">
                        <div className="rz-schedules__fact">
                          <dt className="rz-deflist__k">{tr("Herkomst")}</dt>
                          <dd
                            className="rz-deflist__v rz-schedules__origin rz-mono"
                            title={isPath(job.origin) ? job.origin : undefined}
                          >
                            {shortOrigin(job.origin)}
                          </dd>
                        </div>
                        <div className="rz-schedules__fact">
                          <dt className="rz-deflist__k">{tr("Soort")}</dt>
                          <dd className="rz-deflist__v">
                            {tr(scheduleKindLabels[job.kind])}
                          </dd>
                        </div>
                        <div className="rz-schedules__fact">
                          <dt className="rz-deflist__k">
                            {tr("Tijdzone van de bron")}
                          </dt>
                          <dd className="rz-deflist__v">
                            {translateMessage(job.timezone)}
                          </dd>
                        </div>
                        {job.lastRunAt && (
                          <div className="rz-schedules__fact">
                            <dt className="rz-deflist__k">
                              {tr("Laatste uitvoering")}
                            </dt>
                            <dd className="rz-deflist__v">
                              {timestamp(job.lastRunAt)}
                            </dd>
                          </div>
                        )}
                        {job.lastResult && (
                          <div className="rz-schedules__fact">
                            <dt className="rz-deflist__k">
                              {tr("Laatste status")}
                            </dt>
                            <dd className="rz-deflist__v">
                              {translateMessage(job.lastResult)}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>
        <footer className="rz-schedules__footer">
          {overview && incomplete > 0 && (
            <p>
              {tr(
                "Niet elke bron is volledig gelezen, dus deze lijst kan onvolledig zijn. Bij Je bronnen zie je wat ontbreekt.",
              )}
            </p>
          )}
          <p>
            {tr(
              "Tijdstippen worden getoond in {0}. Een geplande start is geen bevestiging van een geslaagde uitvoering.",
              overview?.timezone || tr("je lokale tijdzone"),
            )}
          </p>
        </footer>
      </PageShell>
    </div>
  );
}
