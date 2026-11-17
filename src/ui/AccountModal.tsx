import { t as tr } from "../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { AssistantAccount, Preferences, Snapshot } from "../shared/types";
import { Terminal } from "./Terminal";
import { api, useWorkbench } from "./model";
import { providerName } from "./primitives";
import {
  Avatar,
  Button,
  Chip,
  Field,
  Input,
  Modal,
  ModalBody,
  ModalFoot,
} from "./rz";

export function AccountModal({
  provider: initialProvider = "claude",
  account,
  startLogin = false,
  close,
}: {
  provider?: "claude" | "codex";
  account?: AssistantAccount;
  startLogin?: boolean; // existing account: skip the form and open the embedded login at once ("Inloggen" pill)
  close: () => void;
}) {
  const {
    info,
    snap,
    companyId,
    run,
    refreshPreferences,
    error,
    notice,
    openSession,
  } = useWorkbench();
  // A login conversation needs a company; without one the form (whose login button is disabled) stays.
  const loginCompany =
    account?.companyIds.find((id) => snap.companies.some((c) => c.id === id)) ||
    companyId;
  const [provider, setProvider] = useState(
      account?.provider || initialProvider,
    ),
    [label, setLabel] = useState(account?.label || ""),
    [configDir, setConfigDir] = useState(
      account?.configDir || `${info.homeDir}/.${initialProvider}-werk`,
    ),
    [companies, setCompanies] = useState<string[]>(
      account?.companyIds || (companyId ? [companyId] : []),
    ),
    [globalDefault, setGlobalDefault] = useState(
      account?.globalDefault || false,
    ),
    [busy, setBusy] = useState(false),
    [starting, setStarting] = useState(
      !!account && startLogin && !!loginCompany,
    ),
    [login, setLogin] = useState<{ id: string; sessionId: string } | null>(
      null,
    ),
    [alive, setAlive] = useState(true),
    started = useRef(false);
  useEffect(() => {
    if (!starting || !account || started.current) return;
    started.current = true;
    // A failure shows the error and falls back to the normal form.
    void run(async () => {
      const sessionId = await api<string>("account.login", {
        id: account.id,
        companyId: loginCompany,
      });
      setLogin({ id: account.id, sessionId });
    }).finally(() => setStarting(false));
  }, []);
  useEffect(() => {
    if (!login) return;
    let disposed = false,
      checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const p = await api<Preferences>("preferences.get");
        const sessions = await api<Snapshot>("snapshot");
        const s = sessions.sessions.find((s) => s.id === login.sessionId);
        if (disposed) return;
        setAlive(!!s?.alive);
        if (
          p.accounts.find((a) => a.id === login.id)?.status === "logged_in" &&
          !s?.agentRunning &&
          !s?.error
        ) {
          await api("session.stop", { id: login.sessionId });
          await refreshPreferences();
          notice(account ? tr("Je bent ingelogd.") : tr("Account toegevoegd."));
          close();
        }
      } catch (e) {
        if (!disposed) error((e as Error).message);
      } finally {
        checking = false;
      }
    };
    const unsubscribe = window.werk.onEvent((event) => {
      if (event.type === "changed") void check();
    });
    const timer = setInterval(() => void check(), 3000);
    void check();
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [login]);
  const save = async (loginNow: boolean) => {
    setBusy(true);
    await run(async () => {
      const id = await api<string>("account.save", {
        id: account?.id,
        value: {
          provider,
          label,
          configDir,
          companyIds: companies,
          globalDefault,
        },
      });
      await refreshPreferences();
      if (loginNow) {
        const sessionId = await api<string>("account.login", {
          id,
          companyId: companies[0] || companyId,
        });
        setLogin({ id, sessionId });
      } else close();
    }).finally(() => setBusy(false));
  };
  return (
    <Modal
      title={
        login || starting
          ? tr("Inloggen bij {0}", providerName(provider))
          : account
            ? tr("Account beheren")
            : tr("Account toevoegen")
      }
      className="rz-account-modal"
      width={520}
      scroll="body"
      close={() => {
        if (!busy && !starting) close();
      }}
    >
      <ModalBody>
        {login ? (
          <>
            <p className="rz-hint">
              {tr(
                "Volg de stappen hieronder. Benchdesk herkent wanneer je bent ingelogd.",
              )}
            </p>
            <div className="rz-account-modal__terminal">
              <Terminal id={login.sessionId} alive={alive} onError={error} />
            </div>
          </>
        ) : starting ? (
          <p className="rz-hint" role="status">
            {tr("Openen…")}
          </p>
        ) : (
          <>
            <Field as="div" label={tr("Assistent")}>
              <div
                className="rz-account-modal__choices"
                role="group"
                aria-label={tr("Assistent")}
              >
                {(["claude", "codex"] as const).map((p) => (
                  <button
                    type="button"
                    disabled={!!account}
                    key={p}
                    className="rz-choice rz-account-modal__choice"
                    aria-pressed={provider === p}
                    onClick={() => {
                      setProvider(p);
                      setConfigDir(
                        `${info.homeDir}/.${p}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "werk"}`,
                      );
                    }}
                  >
                    <Avatar provider={p} size={30} />
                    <span className="rz-account-modal__choice-name">
                      {providerName(p)}
                    </span>
                    <span className="rz-radio" aria-hidden="true">
                      <Check size={9} />
                    </span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label={tr("Naam")}>
              <Input
                required
                placeholder={tr("Bijvoorbeeld: Noorderlicht (Max)")}
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (!account)
                    setConfigDir(
                      `${info.homeDir}/.${provider}-${
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "-")
                          .replace(/^-|-$/g, "") || "werk"
                      }`,
                    );
                }}
              />
            </Field>
            <Field as="div" label={tr("Standaard gebruiken voor")}>
              <div
                className="rz-account-modal__chips"
                role="group"
                aria-label={tr("Standaard gebruiken voor")}
              >
                {snap.companies.map((c) => (
                  <Chip
                    key={c.id}
                    variant="toggle"
                    pressed={companies.includes(c.id)}
                    onClick={() =>
                      setCompanies(
                        companies.includes(c.id)
                          ? companies.filter((id) => id !== c.id)
                          : [...companies, c.id],
                      )
                    }
                  >
                    {c.name}
                  </Chip>
                ))}
                <Chip
                  variant="toggle"
                  pressed={globalDefault}
                  onClick={() => setGlobalDefault(!globalDefault)}
                >
                  {tr("Alle overige")}
                </Chip>
              </div>
            </Field>
            <details className="rz-account-modal__advanced">
              <summary>
                <ChevronRight size={12} aria-hidden="true" />
                <span>{tr("Geavanceerde instellingen")}</span>
              </summary>
              <Field
                as="div"
                label={tr("Configuratiemap")}
                hint={
                  <>
                    {tr("Een eigen map per account via")}{" "}
                    <code>
                      {provider === "claude"
                        ? "CLAUDE_CONFIG_DIR"
                        : "CODEX_HOME"}
                    </code>
                    {tr(". De CLI beheert je login en instellingen.")}
                  </>
                }
              >
                <div className="rz-account-modal__folder">
                  <Input
                    className="rz-mono"
                    aria-label={tr("Configuratiemap")}
                    disabled={!!account}
                    value={configDir}
                    onChange={(e) => setConfigDir(e.target.value)}
                  />
                  <Button
                    disabled={!!account}
                    onClick={() =>
                      void run(async () => {
                        const path = await window.werk.selectFolder();
                        if (path) setConfigDir(path);
                      })
                    }
                  >
                    {tr("Kiezen…")}
                  </Button>
                </div>
              </Field>
            </details>
            <p className="rz-hint">
              {tr(
                "Je logt in bij de gekozen assistent. Benchdesk gebruikt dit account voor de geselecteerde bedrijven.",
              )}
            </p>
          </>
        )}
      </ModalBody>
      {login ? (
        <ModalFoot docked>
          <Button
            variant="quiet"
            onClick={() =>
              void run(async () => {
                const next = await api<Snapshot>("snapshot");
                const s = next.sessions.find((s) => s.id === login.sessionId);
                if (s) openSession(s);
                close();
              })
            }
          >
            {tr("Openen in Aan het werk")}
          </Button>
        </ModalFoot>
      ) : (
        !starting && (
          <ModalFoot docked>
            <Button variant="quiet" disabled={busy} onClick={close}>
              {tr("Annuleren")}
            </Button>
            {account && (
              <Button
                disabled={busy || !label.trim()}
                onClick={() => void save(false)}
              >
                {tr("Opslaan")}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={
                busy ||
                !label.trim() ||
                !configDir ||
                (!companies.length && !companyId)
              }
              onClick={() => void save(true)}
            >
              {busy
                ? tr("Openen…")
                : tr("Inloggen bij {0}", providerName(provider))}
            </Button>
          </ModalFoot>
        )
      )}
    </Modal>
  );
}
