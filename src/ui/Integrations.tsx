import { TypeSafeConnection } from "./Brain";
import { t as tr, translateMessage, locale } from "../shared/i18n";
import { useCallback, useEffect, useId, useState } from "react";
import {
  Check as CheckIcon,
  Ellipsis,
  Mail,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { api, useWorkbench } from "./model";
import { companyTint, sessionTitle } from "./primitives";
import {
  Avatar,
  Badge,
  Button,
  Check,
  Chip,
  Field,
  IconButton,
  Input,
  Menu,
  Modal,
  ModalBody,
  ModalFoot,
  PageHead,
  PageShell,
  Row,
  RowText,
  Section,
  SectionLabel,
  StatusDot,
  TextButton,
} from "./rz";
import type {
  GmailAccount,
  GmailAccess,
  IntegrationOverview,
} from "../shared/integrations";
import { ExternalIntegrationCards } from "./ExternalIntegrations";
import { useDesign } from "./Theme";

const accessLabel = (value: GmailAccess) =>
  value === "draft"
    ? tr("Volgens bedrijfsrechten")
    : value === "read"
      ? tr("Alleen lezen")
      : tr("Geen Gmail");
// The native <select> stays (keyboard, screen reader, smoke `selectOption`); the chip only shows its value.
function AccessChip({
  value,
  options,
  label,
  id,
  disabled,
  onChange,
}: {
  value: GmailAccess;
  options: GmailAccess[];
  label: string;
  id?: string;
  disabled?: boolean;
  onChange: (value: GmailAccess) => void;
}) {
  return (
    <Chip
      chevron
      className="rz-integrations__select"
      data-disabled={disabled ? "" : undefined}
      control={
        <select
          id={id}
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as GmailAccess)}
        >
          {options.map((option) => (
            <option value={option} key={option}>
              {accessLabel(option)}
            </option>
          ))}
        </select>
      }
    >
      {accessLabel(value)}
    </Chip>
  );
}
const pageAccess: GmailAccess[] = ["none", "read", "draft"],
  launchAccess: GmailAccess[] = ["draft", "read", "none"];
function connectedSince(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d
        .toLocaleDateString(locale(), {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
        .replace(/\./g, "");
}

function GmailMark() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Gmail">
      <path fill="#4285f4" d="M2 6.2v11.6c0 1 .8 1.7 1.7 1.7h2.5V9.4L2 6.2Z" />
      <path
        fill="#34a853"
        d="M17.8 9.4v10.1h2.5c.9 0 1.7-.7 1.7-1.7V6.2l-4.2 3.2Z"
      />
      <path
        fill="#fbbc04"
        d="M17.8 9.4 22 6.2V5.1c0-2.1-2.4-3.3-4-2L12 7.6l5.8 4.3V9.4Z"
      />
      <path
        fill="#ea4335"
        d="M6.2 9.4V12L12 16.4l5.8-4.4V9.4L12 13.7 2 6.2V5.1c0-2.1 2.4-3.3 4-2l6 4.5 6-4.5 2.1 2.8L12 12 6.2 7.6v1.8Z"
      />
    </svg>
  );
}

export function Integrations() {
  const { snap, companyId, company, info, error, notice } = useWorkbench();
  // Minimaal: no green pill in the catalogue or the account rows; the modals keep their one primary action.
  const minimal = useDesign() === "minimaal";
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [failure, setFailure] = useState("");
  const [setup, setSetup] = useState(false),
    [adding, setAdding] = useState(false),
    [removing, setRemoving] = useState<GmailAccount | null>(null);
  const [clientId, setClientId] = useState(""),
    [secret, setSecret] = useState("");
  const [drafts, setDrafts] = useState(false),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (info.browser) return;
    try {
      const value = await api<IntegrationOverview>("integrations.get");
      // A running background service can briefly be from the previous app
      // version during an in-place upgrade. Keep the page usable until that
      // service restarts and begins returning the new provider collection.
      setOverview({
        ...value,
        external: Array.isArray(value.external) ? value.external : [],
      });
      setFailure("");
    } catch (e) {
      setFailure((e as Error).message);
    }
  }, [info.browser]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (overview?.pending?.status !== "waiting") return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [overview?.pending?.status, refresh]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const configure = () => {
    setClientId(overview?.clientId || "");
    setSecret("");
    setSetup(true);
  };
  const waiting = overview?.pending?.status === "waiting";
  const link = (
    a: GmailAccount,
    id: string,
    enabled: boolean,
    allowDrafts = false,
  ) =>
    action(async () => {
      const links = [
        ...a.links.filter((l) => l.companyId !== id),
        ...(enabled ? [{ companyId: id, drafts: allowDrafts }] : []),
      ];
      setOverview(
        (value) =>
          value && {
            ...value,
            accounts: value.accounts.map((account) =>
              account.id === a.id ? { ...account, links } : account,
            ),
          },
      );
      try {
        await api("integrations.links", { id: a.id, links });
      } catch (e) {
        await refresh();
        throw e;
      }
    });
  const begin = (account?: GmailAccount) =>
    action(async () => {
      await api("integrations.connect", {
        companyId: companyId || account?.links[0]?.companyId,
        drafts: account
          ? account.status === "reconnect"
            ? account.canDraft
            : true
          : drafts,
        ...(account ? { accountId: account.id } : {}),
      });
      setAdding(false);
    });
  const activeSessions = snap.sessions.filter(
    (s) =>
      s.alive &&
      s.provider !== "shell" &&
      (s.purpose || "work") === "work" &&
      s.companyId === companyId,
  );
  return (
    <>
      <PageShell
        width="wide"
        className="rz-integrations"
        data-test="integrations-page"
      >
        <PageHead
          title={tr("Koppelingen")}
          meta={tr(
            "Koppel je apps één keer. Kies per bedrijf wat je assistenten mogen gebruiken.",
          )}
        />
        <Section className="rz-integrations__section rz-integrations__catalog">
          <SectionLabel as="h2">{tr("Beschikbaar")}</SectionLabel>
          <div className="rz-integrations__cards">
            <TypeSafeConnection key={companyId} />
            <article
              className="rz-integrations__provider-card"
              data-connected={overview?.accounts.length ? "" : undefined}
              data-test="gmail-provider-card"
            >
              <button
                type="button"
                className="rz-integrations__card-head"
                aria-label={tr("Gmail-instellingen")}
                disabled={info.browser || !overview}
                onClick={configure}
              >
                <span className="rz-integrations__brand rz-integrations__brand--gmail">
                  <GmailMark />
                </span>
                <div className="rz-integrations__identity">
                  <h3 className="rz-integrations__name">Gmail</h3>
                  <p className="rz-integrations__card-copy">
                    {tr(
                      "Mails zoeken, gesprekken lezen en concepten klaarzetten.",
                    )}
                  </p>
                </div>
              </button>
              <div className="rz-integrations__card-foot">
                <span className="rz-integrations__card-state">
                  <StatusDot
                    tone={overview?.accounts.length ? "accent" : "muted"}
                  />
                  <span>
                    {info.browser
                      ? tr("Alleen in de desktop-app")
                      : !overview
                        ? tr("Koppelingen laden…")
                        : overview.accounts.length
                          ? tr("{0} verbonden", overview.accounts.length)
                          : overview.configured
                            ? tr("Google-app ingesteld")
                            : tr("Nog niet ingesteld")}
                  </span>
                </span>
                <div className="rz-integrations__card-actions">
                  <Button
                    size="sm"
                    variant={minimal ? "secondary" : "primary"}
                    disabled={
                      info.browser || busy || waiting || !companyId || !overview
                    }
                    onClick={() =>
                      overview?.configured
                        ? (setDrafts(false), setAdding(true))
                        : configure()
                    }
                  >
                    {info.browser
                      ? minimal
                        ? tr("Verbinden") // the status next to it already says "Alleen in de desktop-app"
                        : tr("Desktop-app")
                      : overview?.configured
                        ? tr("Account verbinden")
                        : tr("Gmail instellen")}
                  </Button>
                  {!info.browser && overview && (
                    <IconButton
                      size="sm"
                      label={tr("Google-instellingen")}
                      onClick={configure}
                      disabled={busy || waiting}
                    >
                      <Settings2 size={14} />
                    </IconButton>
                  )}
                </div>
              </div>
            </article>
            <ExternalIntegrationCards
              overview={overview}
              companyId={companyId || ""}
              companyName={company?.name}
              browser={!!info.browser}
              busy={busy}
              action={action}
              notice={notice}
            />
          </div>
        </Section>
        {info.browser ? (
          <div className="rz-integrations__notice">
            <span className="rz-integrations__tile" aria-hidden="true">
              <Mail size={15} />
            </span>
            <div className="rz-integrations__identity">
              <h2 className="rz-integrations__name">
                {tr("Verbind Gmail in de desktop-app")}
              </h2>
              <p className="rz-integrations__notice-text">
                {tr(
                  "De desktop-app bewaart je Google-toegang met de beveiligde opslag van je computer. Open daar Koppelingen om Gmail in te stellen.",
                )}
              </p>
            </div>
          </div>
        ) : (
          <>
            {failure && (
              <div role="alert" className="rz-integrations__status">
                <StatusDot tone="warn" />
                <span className="rz-integrations__status-text">
                  {translateMessage(failure)}
                </span>
                <Button
                  size="sm"
                  className="rz-integrations__retry"
                  onClick={() => void refresh()}
                >
                  {tr("Opnieuw proberen")}
                </Button>
              </div>
            )}
            {!overview && !failure && (
              <p role="status" className="rz-integrations__note">
                {tr("Koppelingen laden…")}
              </p>
            )}
            {overview && (
              <>
                {!overview.configured && (
                  <p className="rz-integrations__note">
                    {tr(
                      "Eenmalig: voeg de Google-appgegevens toe. Daarna verbind je accounts met ‘Inloggen bij Google’.",
                    )}
                  </p>
                )}
                {overview.pending && (
                  <div role="status" className="rz-integrations__status">
                    {overview.pending.status === "complete" ? (
                      <CheckIcon
                        size={14}
                        className="rz-integrations__done"
                        aria-hidden="true"
                      />
                    ) : (
                      <StatusDot
                        tone={
                          overview.pending.status === "error" ? "warn" : "blue"
                        }
                      />
                    )}
                    <span className="rz-integrations__status-text">
                      {translateMessage(overview.pending.message)}
                    </span>
                    {waiting && (
                      <TextButton
                        disabled={busy}
                        onClick={() =>
                          void action(() => api("integrations.cancel"))
                        }
                      >
                        {tr("Annuleren")}
                      </TextButton>
                    )}
                  </div>
                )}
                {overview.accounts.length > 0 && (
                  <Section className="rz-integrations__section">
                    <SectionLabel as="h2" right={tr("Toegang per bedrijf")}>
                      {tr("Verbonden accounts")}
                    </SectionLabel>
                    <div className="rz-integrations__groups">
                      {overview.accounts.map((a) => {
                        const since = connectedSince(a.connectedAt);
                        // Same wording as before: a broken connection asks to reconnect, a read-only one to add
                        // the draft scope; both go through `begin(a)`.
                        const needsAction =
                          a.status === "reconnect" || !a.canDraft;
                        const reconnectLabel =
                          a.status !== "reconnect" && !a.canDraft
                            ? tr("Conceptrechten toevoegen")
                            : tr("Opnieuw verbinden");
                        const reconnectDisabled =
                          busy || waiting || (!companyId && !a.links.length);
                        return (
                          <div
                            className="rz-integrations__group"
                            data-account-id={a.id}
                            key={a.id}
                          >
                            <Row
                              as="div"
                              size="lg"
                              quiet
                              className="rz-integrations__account"
                            >
                              <div className="rz-integrations__identity">
                                <h3 className="rz-integrations__name">
                                  {a.email}
                                </h3>
                                <span className="rz-integrations__sub">
                                  {since
                                    ? tr("Gmail · verbonden sinds {0}", since)
                                    : "Gmail"}
                                </span>
                              </div>
                              <StatusDot
                                className="rz-integrations__state"
                                tone={
                                  a.status === "connected" ? "accent" : "warn"
                                }
                                label={
                                  a.status === "connected"
                                    ? tr("Verbonden met Google")
                                    : tr("Opnieuw verbinden nodig")
                                }
                              />
                              <div className="rz-integrations__actions">
                                {needsAction && (
                                  <Button
                                    size="sm"
                                    variant={
                                      a.status === "reconnect" && !minimal
                                        ? "primary"
                                        : "secondary"
                                    }
                                    disabled={reconnectDisabled}
                                    onClick={() => void begin(a)}
                                  >
                                    {reconnectLabel}
                                  </Button>
                                )}
                                <Menu
                                  label={tr("Opties voor {0}", a.email)}
                                  align="right"
                                  items={[
                                    {
                                      id: "reconnect",
                                      label: reconnectLabel,
                                      disabled: reconnectDisabled,
                                      onSelect: () => void begin(a),
                                    },
                                    { type: "separator" },
                                    {
                                      id: "remove",
                                      label: tr("Verbinding verwijderen"),
                                      tone: "warn",
                                      disabled: busy || waiting,
                                      onSelect: () => setRemoving(a),
                                    },
                                  ]}
                                  trigger={(props) => (
                                    <IconButton
                                      {...props}
                                      size="sm"
                                      label={tr("Opties voor {0}", a.email)}
                                      title={tr("Meer")}
                                    >
                                      <Ellipsis size={14} />
                                    </IconButton>
                                  )}
                                />
                              </div>
                            </Row>
                            <div className="rz-colhead rz-integrations__cols">
                              <span>{tr("Bedrijf")}</span>
                              <span>{tr("Lezen")}</span>
                              <span>{tr("Concepten")}</span>
                            </div>
                            {snap.companies.map((c) => {
                              const grant = a.links.find(
                                (l) => l.companyId === c.id,
                              );
                              return (
                                <Row
                                  as="div"
                                  size="sm"
                                  quiet
                                  className="rz-integrations__company-row"
                                  data-company-id={c.id}
                                  key={c.id}
                                >
                                  <span className="rz-integrations__company">
                                    <Badge
                                      name={c.name}
                                      tint={companyTint(c.id, snap)}
                                    />
                                    <span className="rz-integrations__company-name">
                                      {c.name}
                                    </span>
                                    {c.id === companyId && (
                                      <span className="rz-integrations__current">
                                        {tr("Huidig bedrijf")}
                                      </span>
                                    )}
                                  </span>
                                  <span className="rz-integrations__cell">
                                    <Check
                                      shape="square"
                                      label={tr(
                                        "Mails lezen: {0}, {1}",
                                        a.email,
                                        c.name,
                                      )}
                                      checked={!!grant}
                                      disabled={busy}
                                      onChange={(checked) =>
                                        void link(a, c.id, checked)
                                      }
                                    />
                                  </span>
                                  <span className="rz-integrations__cell">
                                    <Check
                                      shape="square"
                                      label={tr(
                                        "Concepten maken: {0}, {1}",
                                        a.email,
                                        c.name,
                                      )}
                                      checked={!!grant?.drafts}
                                      disabled={busy || !grant || !a.canDraft}
                                      onChange={(checked) =>
                                        void link(a, c.id, true, checked)
                                      }
                                    />
                                  </span>
                                </Row>
                              );
                            })}
                            {!a.links.length && (
                              <p className="rz-integrations__note">
                                {tr(
                                  "Kies een bedrijf om dit account beschikbaar te maken voor gesprekken.",
                                )}
                              </p>
                            )}
                            {!a.canDraft && (
                              <p className="rz-integrations__note">
                                {tr(
                                  "Alleen lezen toegestaan door Google. Voeg conceptrechten toe om concepten te kunnen maken.",
                                )}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Section>
                )}
                <p className="rz-integrations__foot">
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span>
                    {tr(
                      "Google-toegang wordt versleuteld bewaard. Gesprekken krijgen alleen de rechten die je hier toestaat. Benchdesk kan geen e-mails versturen.",
                    )}
                  </span>
                </p>
              </>
            )}
          </>
        )}
      </PageShell>
      {setup && (
        <Modal
          title={tr("Gmail-instellingen")}
          subtitle={company?.name}
          close={() => !busy && setSetup(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api("integrations.configure", {
                  clientId,
                  clientSecret: secret,
                });
                setSecret("");
                setSetup(false);
                notice(
                  tr(
                    "Google-app ingesteld. Je kunt nu een Gmail-account verbinden.",
                  ),
                );
              });
            }}
          >
            <ModalBody>
              <p className="rz-lead rz-integrations__lead">
                {tr(
                  "Gebruik een Google Cloud-project waarin de Gmail API aan staat. Maak een OAuth-client van het type",
                )}{" "}
                <strong>{tr("Desktop-app")}</strong>{" "}
                {tr(
                  "en voeg bij een test-app je e-mailadres toe als testgebruiker.",
                )}
              </p>
              <Field label={tr("Google-clientbestand importeren")}>
                <input
                  type="file"
                  className="rz-integrations__file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={async (e) => {
                    const file = e.currentTarget.files?.[0];
                    if (!file) return;
                    try {
                      if (file.size > 50000)
                        throw new Error(
                          tr("Kies het kleine JSON-clientbestand van Google."),
                        );
                      const value = JSON.parse(await file.text()).installed;
                      if (!value?.client_id || !value?.client_secret)
                        throw new Error(
                          tr(
                            "Gebruik een clientbestand van het type Desktop-app.",
                          ),
                        );
                      setClientId(value.client_id);
                      setSecret(value.client_secret);
                    } catch (e) {
                      error((e as Error).message);
                    }
                  }}
                />
              </Field>
              <Field label={tr("Client-ID")}>
                <Input
                  value={clientId}
                  required
                  disabled={busy}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="…apps.googleusercontent.com"
                  autoComplete="off"
                />
              </Field>
              <Field label={tr("Client secret")}>
                <Input
                  value={secret}
                  type="password"
                  required
                  disabled={busy}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="new-password"
                  placeholder={tr("Uit het Google-clientbestand")}
                />
              </Field>
              <p className="rz-hint">
                {tr(
                  "Je Google-wachtwoord vul je alleen in op de inlogpagina van Google. Deze appgegevens identificeren Benchdesk bij Google.",
                )}
              </p>
              {overview && activeSessions.length > 0 && (
                <section
                  className="rz-integrations__settings-sessions rz-integrations__sessions"
                  data-test="integration-sessions"
                >
                  <div className="rz-integrations__settings-head">
                    <h3>{tr("Gesprekstoegang")}</h3>
                    <p>
                      {tr(
                        "Beperk Gmail alleen wanneer een actief gesprek minder toegang nodig heeft dan het bedrijf toestaat.",
                      )}
                    </p>
                  </div>
                  <div className="rz-integrations__settings-list">
                    {activeSessions.map((s) => {
                      const title = sessionTitle(s, snap);
                      return (
                        <Row
                          as="div"
                          size="sm"
                          quiet
                          className="rz-integrations__session"
                          data-session-id={s.id}
                          key={s.id}
                        >
                          <Avatar provider={s.provider} size={22} />
                          <RowText title={title} />
                          <AccessChip
                            label={tr("Gmail-toegang voor {0}", title)}
                            options={pageAccess}
                            value={overview.sessions[s.id] || "none"}
                            disabled={busy}
                            onChange={(access) =>
                              void action(() =>
                                api("integrations.session", {
                                  id: s.id,
                                  access,
                                }),
                              )
                            }
                          />
                        </Row>
                      );
                    })}
                  </div>
                </section>
              )}
              <ModalFoot>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setSetup(false)}
                >
                  {tr("Annuleren")}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy || !clientId || !secret}
                >
                  {busy ? tr("Opslaan…") : tr("Instellingen opslaan")}
                </Button>
              </ModalFoot>
            </ModalBody>
          </form>
        </Modal>
      )}
      {adding && (
        <Modal
          title={tr("Gmail verbinden")}
          subtitle={tr("Beschikbaar maken voor {0}", company?.name || "")}
          width="sm"
          close={() => !busy && setAdding(false)}
        >
          <ModalBody>
            <p className="rz-lead">
              {tr(
                "Log in bij Google en geef toestemming om mails te zoeken en gesprekken te lezen.",
              )}
            </p>
            <div className="rz-integrations__consent-block">
              <label className="rz-integrations__consent">
                <input
                  type="checkbox"
                  checked={drafts}
                  disabled={busy}
                  onChange={(e) => setDrafts(e.target.checked)}
                />
                <span>{tr("Ook conceptantwoorden laten maken")}</span>
              </label>
              {drafts && (
                <p className="rz-hint">
                  {tr(
                    "Google vraagt hiervoor ook verzendrechten. Benchdesk gebruikt deze toestemming uitsluitend om concepten te maken; verzenden is niet beschikbaar.",
                  )}
                </p>
              )}
            </div>
            <ModalFoot>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                {tr("Annuleren")}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void begin()}
              >
                {busy ? tr("Browser openen…") : tr("Inloggen bij Google")}
              </Button>
            </ModalFoot>
          </ModalBody>
        </Modal>
      )}
      {removing && (
        <Modal
          title={tr("Gmail-verbinding verwijderen?")}
          subtitle={removing.email}
          width="sm"
          close={() => !busy && setRemoving(null)}
        >
          <ModalBody>
            <p className="rz-lead">
              {tr(
                "Alle bedrijven en gesprekken verliezen toegang via deze verbinding. De opgeslagen Google-toegang wordt uit Benchdesk verwijderd. Je mails blijven in Gmail.",
              )}
            </p>
            <p className="rz-hint">
              {tr(
                "Google-toestemming kun je daarnaast intrekken in de beveiligingsinstellingen van je Google-account.",
              )}
            </p>
            <ModalFoot>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                {tr("Annuleren")}
              </Button>
              <Button
                className="rz-integrations__danger"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api("integrations.remove", { id: removing.id });
                    setRemoving(null);
                  })
                }
              >
                {tr("Verbinding verwijderen")}
              </Button>
            </ModalFoot>
          </ModalBody>
        </Modal>
      )}
    </>
  );
}

export function GmailSessionChoice({
  value,
  onChange,
  disabled,
}: {
  value: GmailAccess;
  onChange: (v: GmailAccess) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="rz-integrations-choice" data-test="gmail-session-choice">
      <label className="rz-integrations-choice__label" htmlFor={id}>
        <Mail size={13} aria-hidden="true" />
        {tr("Gmail-toegang")}
      </label>
      <AccessChip
        id={id}
        label={tr("Gmail-toegang")}
        options={launchAccess}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
      <p className="rz-integrations-choice__hint">
        {tr(
          "Gebruikt alleen de accounts die bij Koppelingen aan dit bedrijf zijn gekoppeld.",
        )}
      </p>
    </div>
  );
}
