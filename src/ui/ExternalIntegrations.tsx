import { useMemo, useState } from "react";
import { Github, Mic2, Network, Send, Sparkles } from "lucide-react";
import { t as tr } from "../shared/i18n";
import type {
  ExternalProvider,
  IntegrationOverview,
} from "../shared/integrations";
import { api } from "./model";
import {
  Button,
  Field,
  Input,
  Modal,
  ModalBody,
  ModalFoot,
  StatusDot,
  TextButton,
} from "./rz";
import { useDesign } from "./Theme";

type ProviderDefinition = {
  id: ExternalProvider;
  name: string;
  description: string;
  instructions: string;
  keyLabel: string;
  keyPlaceholder: string;
};

const providers: ProviderDefinition[] = [
  {
    id: "fireflies",
    name: "Fireflies",
    description: "Vergaderingen, transcripties en actiepunten doorzoeken.",
    instructions:
      "Kopieer je API-sleutel via Fireflies → Settings → Developer Settings.",
    keyLabel: "Fireflies API-sleutel",
    keyPlaceholder: "API-sleutel",
  },
  {
    id: "pocket",
    name: "Pocket",
    description: "Opnames, transcripties, samenvattingen en tags lezen.",
    instructions:
      "Maak een API-sleutel aan via Pocket → Settings → Developer → API Keys.",
    keyLabel: "Pocket API-sleutel",
    keyPlaceholder: "pk_…",
  },
  {
    id: "unipile",
    name: "Unipile",
    description: "Accounts en gesprekken uit je communicatiekanalen lezen.",
    instructions:
      "Gebruik de DSN en access token uit je Unipile API-dashboard.",
    keyLabel: "Unipile access token",
    keyPlaceholder: "Access token",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests en reacties lezen.",
    instructions:
      "Gebruik een fine-grained personal access token met alleen leestoegang tot de gewenste repositories.",
    keyLabel: "GitHub personal access token",
    keyPlaceholder: "github_pat_…",
  },
  {
    id: "blotato",
    name: "Blotato",
    description:
      "Social posts plannen en publiceren via de MCP-server van Blotato.",
    instructions:
      "Kopieer je API-sleutel via Blotato → Settings → API. Publiceren vraagt standaard eerst jouw toestemming.",
    keyLabel: "Blotato API-sleutel",
    keyPlaceholder: "API-sleutel",
  },
];

function ProviderMark({ provider }: { provider: ExternalProvider }) {
  const icon =
    provider === "fireflies" ? (
      <Sparkles size={21} />
    ) : provider === "pocket" ? (
      <Mic2 size={21} />
    ) : provider === "unipile" ? (
      <Network size={21} />
    ) : provider === "blotato" ? (
      <Send size={20} />
    ) : (
      <Github size={22} />
    );
  return (
    <span
      className={`rz-integrations__brand rz-integrations__brand--${provider}`}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

export function ExternalIntegrationCards({
  overview,
  companyId,
  companyName,
  browser,
  busy,
  action,
  notice,
}: {
  overview: IntegrationOverview | null;
  companyId: string;
  companyName?: string;
  browser: boolean;
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<void>;
  notice: (message: string) => void;
}) {
  // Minimaal: a secondary "Verbinden" pill per row (green is kept for the one action in the modal), and the
  // settings modal keeps two pills; testing and disconnecting become text actions on the left.
  const minimal = useDesign() === "minimaal";
  const [selected, setSelected] = useState<ExternalProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [dsn, setDsn] = useState("");
  const definition = useMemo(
    () => providers.find((provider) => provider.id === selected),
    [selected],
  );
  const connection = selected
    ? overview?.external?.find(
        (item) => item.provider === selected && item.companyId === companyId,
      )
    : undefined;
  const open = (provider: ExternalProvider) => {
    setApiKey("");
    setDsn("");
    setSelected(provider);
  };
  const testConnection = () =>
    void action(async () => {
      if (!selected || !definition) return;
      await api("integrations.provider.test", { provider: selected, companyId });
      notice(tr("Verbinding met {0} werkt.", definition.name));
    });
  const disconnect = () =>
    void action(async () => {
      if (!selected || !definition) return;
      await api("integrations.provider.remove", {
        provider: selected,
        companyId,
      });
      setSelected(null);
      notice(tr("Verbinding met {0} verwijderd.", definition.name));
    });
  return (
    <>
      {providers.map((provider) => {
        const connected = overview?.external?.find(
          (item) =>
            item.provider === provider.id && item.companyId === companyId,
        );
        return (
          <article
            className="rz-integrations__provider-card"
            data-connected={connected ? "" : undefined}
            data-test={`${provider.id}-provider-card`}
            key={provider.id}
          >
            <button
              type="button"
              className="rz-integrations__card-head"
              aria-label={tr("{0}-instellingen", provider.name)}
              disabled={browser || !overview || !companyId}
              onClick={() => open(provider.id)}
            >
              <ProviderMark provider={provider.id} />
              <div className="rz-integrations__identity">
                <h3 className="rz-integrations__name">{provider.name}</h3>
                <p className="rz-integrations__card-copy">
                  {tr(provider.description)}
                </p>
              </div>
            </button>
            <div className="rz-integrations__card-foot">
              <span className="rz-integrations__card-state">
                <StatusDot tone={connected ? "accent" : "muted"} />
                <span>
                  {browser
                    ? tr("Alleen in de desktop-app")
                    : connected
                      ? tr("Verbonden als {0}", connected.label)
                      : tr("Nog niet verbonden")}
                </span>
              </span>
              <Button
                size="sm"
                variant={minimal ? "secondary" : "primary"}
                disabled={browser || busy || !overview || !companyId}
                onClick={() => open(provider.id)}
              >
                {browser
                  ? minimal
                    ? tr("Verbinden") // the status next to it already says "Alleen in de desktop-app"
                    : tr("Desktop-app")
                  : connected
                    ? tr("Beheren")
                    : tr("Verbinden")}
              </Button>
            </div>
          </article>
        );
      })}
      {selected && definition && (
        <Modal
          title={tr("{0}-instellingen", definition.name)}
          subtitle={companyName}
          close={() => !busy && setSelected(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action(async () => {
                await api("integrations.provider.configure", {
                  provider: selected,
                  companyId,
                  apiKey,
                  ...(selected === "unipile" ? { dsn } : {}),
                });
                setApiKey("");
                setDsn("");
                setSelected(null);
                notice(tr("{0} is verbonden voor {1}.", definition.name, companyName));
              });
            }}
          >
            <ModalBody>
              <p className="rz-lead rz-integrations__lead">
                {tr(definition.instructions)}
              </p>
              {selected === "unipile" && (
                <Field label="DSN">
                  <Input
                    value={dsn}
                    required
                    disabled={busy}
                    onChange={(event) => setDsn(event.target.value)}
                    placeholder="https://api123.unipile.com:1337"
                    autoComplete="off"
                  />
                </Field>
              )}
              <Field
                label={tr(definition.keyLabel)}
                hint={
                  connection
                    ? tr("Laat leeg als je alleen de bestaande verbinding wilt testen.")
                    : undefined
                }
              >
                <Input
                  value={apiKey}
                  type="password"
                  required={!connection}
                  disabled={busy}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={definition.keyPlaceholder}
                  autoComplete="off"
                />
              </Field>
              {connection && (
                <p className="rz-integrations__foot">
                  <StatusDot tone="accent" />
                  <span>{tr("Verbonden als {0}", connection.label)}</span>
                </p>
              )}
              <p className="rz-integrations__note">
                {tr(
                  "De sleutel wordt versleuteld bewaard. Deze koppeling geeft assistenten alleen leestoegang binnen dit bedrijf.",
                )}
              </p>
            </ModalBody>
            {minimal ? (
              // `docked`: this foot sits outside ModalBody, so it needs the body's side padding of its own.
              <ModalFoot
                docked
                left={
                  connection && (
                    <span className="rz-integrations__foot-links">
                      <TextButton disabled={busy} onClick={testConnection}>
                        {tr("Verbinding testen")}
                      </TextButton>
                      <TextButton
                        className="rz-integrations__danger"
                        disabled={busy}
                        onClick={disconnect}
                      >
                        {tr("Ontkoppelen")}
                      </TextButton>
                    </span>
                  )
                }
              >
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                >
                  {tr("Annuleren")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !!connection && !apiKey}
                >
                  {busy ? tr("Opslaan…") : tr("Opslaan en verbinden")}
                </Button>
              </ModalFoot>
            ) : (
              <ModalFoot>
                {connection && (
                  <Button
                    type="button"
                    className="rz-integrations__danger"
                    disabled={busy}
                    onClick={disconnect}
                  >
                    {tr("Ontkoppelen")}
                  </Button>
                )}
                {connection && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={testConnection}
                  >
                    {tr("Verbinding testen")}
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                >
                  {tr("Annuleren")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !!connection && !apiKey}
                >
                  {busy ? tr("Opslaan…") : tr("Opslaan en verbinden")}
                </Button>
              </ModalFoot>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}
