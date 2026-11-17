import { t as tr, translateMessage } from "../shared/i18n";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Monitor, RefreshCw } from "lucide-react";
import type { Session } from "../shared/types";
import type { ComputerStatus } from "../shared/computer";
import { api, useWorkbench } from "./model";
import { sessionTitle } from "./primitives";
import { Button, IconButton, Modal, ModalBody, StatusDot } from "./rz";

export const computerSupported = (
  info: { browser?: boolean; platform?: string },
  session: Session,
) =>
  !info.browser && info.platform === "darwin" && session.provider === "codex";
// `open`/`onOpenChange`/`hideTrigger` let the Minimaal pane open this modal from its ⋯ menu; without them the
// button keeps its own state, as before.
export function ComputerButton({
  session,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  session: Session;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const { info, snap } = useWorkbench();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (value: boolean) =>
    onOpenChange ? onOpenChange(value) : setOwnOpen(value);
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [failure, setFailure] = useState("");
  const supported = computerSupported(info, session);
  const refresh = async () => {
    try {
      setStatus(
        await api<ComputerStatus>("computer.get", { sessionId: session.id }),
      );
      setFailure("");
    } catch (e) {
      setFailure((e as Error).message);
    }
  };
  useEffect(() => {
    if (!supported || !open) return;
    void refresh();
  }, [supported, open, session.id]);
  if (!supported) return null;
  const version = status?.sessionVersion || status?.version;
  return (
    <>
      {!hideTrigger && (
        <IconButton
          label={tr("Computer")}
          title={tr("OpenAI Computer Use voor dit gesprek")}
          data-test="computer-toggle"
          onClick={() => setOpen(true)}
        >
          <Monitor size={15} />
        </IconButton>
      )}
      {open &&
        // In a portal: a canvas pane is a size container, which would trap a fixed overlay inside the pane.
        createPortal(
          <Modal
            title={tr("Computerbediening")}
            subtitle={sessionTitle(session, snap)}
            close={() => setOpen(false)}
          >
            <ModalBody className="rz-computer" data-test="computer">
              <p className="rz-computer__text">
                {tr(
                  "Benchdesk gebruikt OpenAI Computer Use: dezelfde koppeling als in ChatGPT en Codex, met bediening per app en de cursor van Computer Use.",
                )}
              </p>
              <div className="rz-computer__list">
                <div className="rz-computer__row">
                  <span className="rz-computer__label">
                    <span className="rz-computer__name">
                      OpenAI Computer Use
                    </span>
                    <StatusDot
                      tone={
                        status
                          ? status.available
                            ? "accent"
                            : "warn"
                          : "muted"
                      }
                      label={
                        status
                          ? status.available
                            ? tr("Geïnstalleerd")
                            : tr("Nog niet beschikbaar")
                          : tr("Controleren…")
                      }
                    />
                  </span>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={13} aria-hidden="true" />}
                    onClick={() => void refresh()}
                  >
                    {tr("Controleren")}
                  </Button>
                </div>
                <div className="rz-computer__row">
                  <span className="rz-computer__label">
                    <span className="rz-computer__name">
                      {tr("Dit gesprek")}
                    </span>
                    <StatusDot
                      tone={
                        status
                          ? status.configured
                            ? "accent"
                            : "warn"
                          : "muted"
                      }
                      label={
                        status
                          ? status.configured
                            ? tr("Koppeling ingesteld")
                            : tr("Nieuw of hervat gesprek nodig")
                          : tr("Controleren…")
                      }
                    />
                  </span>
                </div>
              </div>
              {failure && (
                <p className="rz-error rz-error--block" role="alert">
                  {translateMessage(failure)}
                </p>
              )}
              {status && !status.available && (
                <p className="rz-computer__text">
                  {translateMessage(status.reason)}
                </p>
              )}
              {status?.available && !status.configured && (
                <p className="rz-computer__text">
                  {tr(
                    "Dit gesprek is gestart zonder deze koppeling. Start een nieuw Codex-gesprek, of stop en hervat dit gesprek als hervatten beschikbaar is. Je taakcontext blijft bewaard.",
                  )}
                </p>
              )}
              {status?.configured && (
                <div className="rz-computer__ready">
                  <strong>{tr("Klaar voor een computeropdracht")}</strong>
                  <span>
                    {tr(
                      "Vraag bijvoorbeeld: “Gebruik Computer Use om Rekenmachine te openen en 12 × 8 uit te rekenen.”",
                    )}
                  </span>
                </div>
              )}
              <p className="rz-computer__hint">
                {tr(
                  "Computer Use regelt de toegang tot apps en toont zijn eigen bediening. macOS-toestemmingen horen bij ‘Codex Computer Use’. Benchdesk vraagt hiervoor geen toegang tot je muis of scherm meer.",
                )}
              </p>
              <details className="rz-disclosure rz-computer__details">
                {/* tabIndex keeps the natively focusable summary inside the Modal's focus trap */}
                <summary tabIndex={0}>
                  {tr("Technische details")}
                  <ChevronRight size={11} aria-hidden="true" />
                </summary>
                <p className="rz-computer__hint">
                  {tr("Technische koppeling: cua_repl · js en js_reset")}
                  {version ? ` · ${version}` : ""}
                </p>
              </details>
            </ModalBody>
          </Modal>,
          document.body,
        )}
    </>
  );
}
