import { t as tr, translateMessage } from "../shared/i18n";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { UpgradeSession } from "../runtime/upgrade";
import { api, useWorkbench } from "./model";
import { companyTint, providerName } from "./primitives";
import {
  Badge,
  Button,
  Empty,
  PageShell,
  Row,
  RowText,
  Section,
  SectionLabel,
} from "./rz";
import { Brand } from "./Theme";

export function UpgradePage({ sessions }: { sessions: UpgradeSession[] }) {
  const { snap, refresh, error } = useWorkbench();
  const [stopping, setStopping] = useState<string[]>([]);
  // The previous version only tells us the company NAME. Its colour is known when that company is in the
  // snapshot already; otherwise the badge stays neutral instead of guessing one.
  const tint = (company: string) => {
    const known = snap.companies.find((c) => c.name === company);
    return known ? companyTint(known.id, snap) : "var(--muted)";
  };
  const stop = (id: string) => {
    setStopping((ids) => [...ids, id]);
    void api("runtime.stopLegacy", { id })
      .then(refresh)
      .catch((e) => error(e.message))
      .finally(() => setStopping((ids) => ids.filter((x) => x !== id)));
  };
  return (
    <div className="rz-appstate" data-test="upgrade-page">
      <div className="rz-appstate__col rz-appstate__col--upgrade">
        <Brand />
        <header className="rz-appstate__head">
          <h1 className="rz-h1">{tr("Je nieuwe Benchdesk staat klaar.")}</h1>
          <p className="rz-lead">
            {tr(
              "Je lopende gesprekken blijven actief in de vorige versie. Sluit ze daar af, of stop ze hieronder wanneer je klaar bent. Benchdesk gaat daarna vanzelf verder.",
            )}
          </p>
        </header>
        {sessions.length > 0 && (
          <Section tight>
            <SectionLabel as="h2">
              {tr("Nog actief in de vorige versie")}
            </SectionLabel>
            {sessions.map((s) => (
              <Row
                as="div"
                quiet
                cols="24px minmax(0, 1fr) auto"
                className="rz-appstate__session"
                data-test="upgrade-session"
                key={s.id}
              >
                <Badge name={s.company} tint={tint(s.company)} size={22} />
                <RowText
                  title={s.title}
                  meta={tr("{0} · {1}", s.company, providerName(s.provider))}
                />
                <Button
                  size="sm"
                  disabled={stopping.includes(s.id)}
                  onClick={() => stop(s.id)}
                >
                  {tr("Gesprek stoppen")}
                </Button>
              </Row>
            ))}
          </Section>
        )}
        <div className="rz-appstate__actions">
          <Button
            variant="primary"
            onClick={() => void refresh().catch(() => {})}
          >
            {tr("Opnieuw controleren")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConnectionError({ message }: { message: string }) {
  const { refresh } = useWorkbench();
  return (
    <div className="rz-appstate" data-test="connection-error">
      <Empty
        title={tr("Benchdesk is nog niet bereikbaar.")}
        action={
          <Button
            variant="primary"
            size="lg"
            onClick={() => void refresh().catch(() => {})}
          >
            {tr("Opnieuw proberen")}
          </Button>
        }
      >
        {translateMessage(message)}
      </Empty>
    </div>
  );
}

export function AppLoading() {
  return (
    <div className="rz-appstate" data-test="app-loading">
      <div className="rz-appstate__loading" role="status">
        <Loader2 size={16} className="rz-spin" aria-hidden="true" />
        {tr("Benchdesk openen…")}
      </div>
    </div>
  );
}

export function NoCompany({ open }: { open: () => void }) {
  return (
    <PageShell className="rz-appstate__page" data-test="no-company">
      <Empty
        title={tr("Welk bedrijf verdient je aandacht?")}
        action={
          <Button variant="primary" size="lg" onClick={open}>
            {tr("Een bedrijf openen")}
          </Button>
        }
      >
        {tr("Je gesprekken blijven beschikbaar bij Aan het werk.")}
      </Empty>
    </PageShell>
  );
}
