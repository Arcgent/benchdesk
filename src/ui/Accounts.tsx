import { t as tr, locale } from "../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { Ellipsis, Plus, RefreshCw } from "lucide-react";
import type { AssistantAccount, Snapshot } from "../shared/types";
import { api, useWorkbench } from "./model";
import { AccountModal } from "./AccountModal";
import { providerName, shortPath, statusTone } from "./primitives";
import {
  Avatar,
  Button,
  Chip,
  IconButton,
  Menu,
  PageHead,
  PageShell,
  Row,
  RowText,
  SectionLabel,
  StatusDot,
  TextButton,
  type MenuItem,
} from "./rz";
import { AccountUsageView, formatUsageTime, useAccountUsage } from "./Usage";
import { useDesign } from "./Theme";

const providers = ["claude", "codex"] as const;
type Assignment = Pick<AssistantAccount, "companyIds" | "globalDefault">;

export function Accounts() {
  const { prefs, run, refreshPreferences, addAccount } = useWorkbench();
  const [modal, setModal] = useState<{
    account: AssistantAccount;
    login: boolean;
  } | null>(null);
  const [checking, setChecking] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  // Login state of every account, or of one ("Opnieuw controleren" in a row).
  const check = async (id?: string) => {
    setChecking((n) => n + 1);
    try {
      await run(async () => {
        await (id ? api("accounts.refresh", { id }) : api("accounts.refresh"));
        await refreshPreferences();
      });
    } finally {
      setChecking((n) => n - 1);
    }
  };
  const refreshAccounts = () => {
    setRefreshKey((k) => k + 1);
    return check();
  };
  useEffect(() => {
    void refreshAccounts();
  }, []);
  // The store re-appends an account on every save; a fixed order keeps a row in place while its company
  // menu is open. First-run accounts first, then by name.
  const accountsOf = (provider: (typeof providers)[number]) =>
    prefs.accounts
      .filter((a) => a.provider === provider)
      .sort(
        (a, b) =>
          Number(b.id.startsWith("default-")) -
            Number(a.id.startsWith("default-")) ||
          a.label.localeCompare(b.label, locale()) ||
          a.id.localeCompare(b.id),
      );
  return (
    <PageShell width="wide" data-test="accounts-page">
      <PageHead
        title={tr("Accounts & gebruik")}
        meta={tr("Welke assistent-accounts je gebruikt, per bedrijf")}
        actions={
          <>
            {/* Announced, not shown: visible text here would push the buttons around while a check runs. */}
            <span className="rz-sr" role="status">
              {checking > 0 && tr("Accounts controleren…")}
            </span>
            <IconButton
              label={tr("Accounts & gebruik vernieuwen")}
              title={
                checking > 0
                  ? tr("Accounts controleren…")
                  : tr(
                      "Accounts & gebruik vernieuwen · maximaal één nieuwe controle per minuut",
                    )
              }
              disabled={checking > 0}
              onClick={() => void refreshAccounts()}
            >
              <RefreshCw size={15} />
            </IconButton>
            <Button variant="primary" plus onClick={() => addAccount()}>
              {tr("Account toevoegen")}
            </Button>
          </>
        }
      />
      {providers.map((provider) => {
        const accounts = accountsOf(provider);
        return (
          <section
            className="rz-accounts__group"
            data-test="account-group"
            data-provider={provider}
            aria-label={providerName(provider)}
            key={provider}
          >
            {/* Explicit heading name: the "+ Account" link renders inside the h2. */}
            <SectionLabel
              as="h2"
              tall
              aria-label={providerName(provider)}
              right={
                accounts.length ? (
                  <TextButton
                    tone="meta"
                    icon={<Plus size={11} aria-hidden="true" />}
                    aria-label={tr(
                      "Nog een {0}-account toevoegen",
                      providerName(provider),
                    )}
                    onClick={() => addAccount(provider)}
                  >
                    {tr("Account")}
                  </TextButton>
                ) : undefined
              }
            >
              <Avatar provider={provider} size={18} />
              <span className="rz-label__name">{providerName(provider)}</span>
            </SectionLabel>
            {accounts.length ? (
              <div className="rz-accounts__table">
                <div className="rz-colhead rz-accounts__cols">
                  <span>{tr("Account")}</span>
                  <span>{tr("Status")}</span>
                  <span>{tr("Ruimte over")}</span>
                  <span className="rz-accounts__cols-end">
                    {tr("Gebruikt voor")}
                  </span>
                </div>
                {accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    refreshKey={refreshKey}
                    check={check}
                    manage={(login) => setModal({ account: a, login })}
                  />
                ))}
              </div>
            ) : (
              <button
                type="button"
                className="rz-accounts__empty"
                onClick={() => addAccount(provider)}
              >
                <Plus size={13} aria-hidden="true" />
                {tr("{0}-account toevoegen", providerName(provider))}
              </button>
            )}
          </section>
        );
      })}
      <p className="rz-accounts__foot">
        {tr(
          "Ruimte wordt bij elke start opnieuw gecontroleerd en hier elke vijf minuten bijgewerkt. Je gebruik telt mee over al je apps en gesprekken.",
        )}
      </p>
      {modal && (
        <AccountModal
          account={modal.account}
          startLogin={modal.login}
          close={() => setModal(null)}
        />
      )}
    </PageShell>
  );
}

function AccountRow({
  account: a,
  refreshKey,
  check,
  manage,
}: {
  account: AssistantAccount;
  refreshKey: number;
  check: (id?: string) => Promise<void>;
  manage: (login: boolean) => void; // the manage form, or straight to the embedded login
}) {
  const { prefs, snap, companyId, info, run, refreshPreferences, openSession } =
    useWorkbench();
  // Minimaal: "Account toevoegen" is the only green pill, the folder of an account without e-mail is a tooltip,
  // and a logged-out account shows the login hint instead of its last (stale) usage bars.
  const minimal = useDesign() === "minimaal";
  const [rechecked, setRechecked] = useState(0);
  const usage = useAccountUsage(a, refreshKey + rechecked);
  // The company menu saves at once and stays open: show the choice right away, the preferences follow.
  const [draft, setDraft] = useState<Assignment | null>(null);
  const saves = useRef(0);
  const assigned = draft || a;
  const siblings = prefs.accounts.filter(
    (b) => b.provider === a.provider && b.id !== a.id,
  );
  const assign = (next: Assignment) => {
    const ticket = ++saves.current;
    setDraft(next);
    void run(async () => {
      await api("account.save", {
        id: a.id,
        value: {
          provider: a.provider,
          label: a.label,
          configDir: a.configDir,
          ...next,
        },
      });
      await refreshPreferences();
    }).finally(() => {
      if (saves.current === ticket) setDraft(null);
    });
  };
  // Only companies that still exist: a stale id would make every later save fail.
  const chosen = snap.companies.filter((c) =>
    assigned.companyIds.includes(c.id),
  );
  const usedFor =
    [
      ...chosen.map((c) => c.name),
      ...(assigned.globalDefault ? [tr("Alle overige")] : []),
    ].join(", ") || tr("Kiezen…");
  const heldBy = (other?: AssistantAccount) =>
    other ? tr("nu: {0}", other.label) : undefined;
  const active = snap.sessions.filter(
    (s) => s.accountId === a.id && s.alive,
  ).length;
  const needsLogin = a.status === "logged_out" || a.status === "expired";
  const facts: MenuItem[] = [
    ...(usage.usage?.plan
      ? [
          {
            type: "label" as const,
            label: tr("Abonnement: {0}", usage.usage.plan),
          },
        ]
      : []),
    {
      type: "label",
      label: a.checkedAt
        ? tr("Login gecontroleerd: {0}", formatUsageTime(a.checkedAt))
        : tr("Login nog niet gecontroleerd"),
    },
    ...(usage.usage?.checkedAt
      ? [
          {
            type: "label" as const,
            label: tr(
              "Gebruik gecontroleerd: {0}",
              formatUsageTime(usage.usage.checkedAt),
            ),
          },
        ]
      : []),
  ];
  return (
    <Row
      as="div"
      size="lg"
      quiet
      cols="subgrid"
      className="rz-accounts__row"
      data-test="account-row"
      data-account-id={a.id}
    >
      <RowText
        className="rz-accounts__identity"
        title={a.label}
        titleProps={minimal && !a.email ? { title: a.configDir } : undefined}
        meta={
          minimal
            ? a.email || undefined
            : a.email || (
                <span title={a.configDir}>
                  {shortPath(a.configDir, info.homeDir)}
                </span>
              )
        }
      />
      <div className="rz-accounts__status">
        <StatusDot
          tone={statusTone("account", a.status)}
          label={
            a.status === "logged_in"
              ? tr("Ingelogd")
              : a.status === "expired"
                ? tr("Login verlopen")
                : a.status === "logged_out"
                  ? tr("Niet ingelogd")
                  : tr("Status nog niet bevestigd")
          }
        />
        {active > 0 && (
          <span className="rz-accounts__active">
            {active === 1
              ? tr("1 gesprek actief")
              : tr("{0} gesprekken actief", active)}
          </span>
        )}
      </div>
      <div className="rz-accounts__usage">
        {minimal && needsLogin ? (
          <div
            className="rz-usage"
            data-test="account-usage"
            role="group"
            aria-label={tr("Gebruik van {0}", a.label)}
          >
            <p className="rz-usage__message">
              {tr("Log in om gebruik te zien")}
            </p>
          </div>
        ) : (
          <AccountUsageView account={a} state={usage} remaining />
        )}
      </div>
      <div className="rz-accounts__actions">
        {needsLogin && (
          <Button
            variant={minimal ? "secondary" : "primary"}
            size="sm"
            aria-label={tr("Inloggen: {0}", a.label)}
            onClick={() => manage(true)}
          >
            {tr("Inloggen")}
          </Button>
        )}
        <Menu
          label={tr("Bedrijven kiezen voor {0}", a.label)}
          align="right"
          items={[
            { type: "label", label: tr("Standaard gebruiken voor") },
            ...snap.companies.map(
              (c): MenuItem => ({
                id: c.id,
                label: c.name,
                hint:
                  heldBy(siblings.find((b) => b.companyIds.includes(c.id))) ||
                  (c.id === companyId ? tr("dit bedrijf") : undefined),
                checked: assigned.companyIds.includes(c.id),
                multi: true,
                onSelect: () =>
                  assign({
                    companyIds: assigned.companyIds.includes(c.id)
                      ? chosen.filter((x) => x.id !== c.id).map((x) => x.id)
                      : [...chosen.map((x) => x.id), c.id],
                    globalDefault: assigned.globalDefault,
                  }),
              }),
            ),
            ...(snap.companies.length ? [{ type: "separator" as const }] : []),
            {
              id: "other",
              label: tr("Alle overige"),
              hint: heldBy(siblings.find((b) => b.globalDefault)),
              checked: assigned.globalDefault,
              multi: true,
              onSelect: () =>
                assign({
                  companyIds: chosen.map((x) => x.id),
                  globalDefault: !assigned.globalDefault,
                }),
            },
          ]}
          trigger={(props) => (
            <Chip
              {...props}
              size="sm"
              chevron
              className="rz-accounts__chip"
              aria-label={tr(
                "Bedrijven kiezen voor {0}: {1}",
                a.label,
                usedFor,
              )}
              title={usedFor}
            >
              {usedFor}
            </Chip>
          )}
        />
        <Menu
          label={tr("Opties voor {0}", a.label)}
          align="right"
          items={[
            {
              id: "check",
              label: tr("Opnieuw controleren"),
              onSelect: () => {
                setRechecked((n) => n + 1);
                void check(a.id);
              },
            },
            {
              id: "login",
              label:
                a.status === "logged_in"
                  ? tr("Opnieuw inloggen")
                  : tr("Inloggen"),
              onSelect: () => manage(true),
            },
            {
              id: "rename",
              label: tr("Hernoemen"),
              onSelect: () => manage(false),
            },
            {
              id: "logout",
              label: tr("Uitloggen"),
              onSelect: () =>
                void run(async () => {
                  const id = await api<string>("account.logout", {
                    id: a.id,
                    companyId,
                  });
                  const next = await api<Snapshot>("snapshot");
                  const s = next.sessions.find((s) => s.id === id);
                  if (s) openSession(s);
                }),
            },
            { type: "separator" },
            {
              id: "remove",
              label: tr("Verwijderen"),
              tone: "warn",
              onSelect: () =>
                void run(async () => {
                  await api("account.remove", { id: a.id });
                  await refreshPreferences();
                }, tr("Accountkoppeling verwijderd.")),
            },
            { type: "separator" },
            ...facts,
          ]}
          trigger={(props) => (
            <IconButton
              {...props}
              size="sm"
              label={tr("Opties voor {0}", a.label)}
              title={tr("Meer")}
            >
              <Ellipsis size={14} />
            </IconButton>
          )}
        />
      </div>
    </Row>
  );
}
