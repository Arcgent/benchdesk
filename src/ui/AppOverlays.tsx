import { t as tr, translateMessage } from "../shared/i18n";
import { Fragment } from "react";
import { Check, Plus, X } from "lucide-react";
import { FileViewer } from "./FileViewer";
import { useWorkbench } from "./model";
import { companyTint, shortPath } from "./primitives";
import {
  Badge,
  IconButton,
  Modal,
  ModalBody,
  Row,
  RowText,
  StatusDot,
  Toast,
} from "./rz";

export function CompanyPicker({ close }: { close: () => void }) {
  const { snap, companyId, switchCompany, edit } = useWorkbench();
  return (
    <Modal title={tr("Open een bedrijf")} width={440} close={close}>
      <ModalBody>
        <div className="rz-picker" data-test="company-picker">
          {snap.companies.map((c) => (
            <Row
              as="button"
              cols="24px minmax(0, 1fr)"
              className="rz-picker__row"
              selected={c.id === companyId}
              data-company-id={c.id}
              key={c.id}
              onClick={() => switchCompany(c.id)}
            >
              <Badge name={c.name} tint={companyTint(c.id, snap)} size={22} />
              <RowText
                title={c.name}
                meta={c.stage || shortPath(c.workspacePath)}
              />
            </Row>
          ))}
          <button
            type="button"
            className="rz-addrow"
            onClick={() => {
              close();
              edit("company");
            }}
          >
            <span className="rz-addrow__box" aria-hidden="true">
              <Plus size={10} />
            </span>
            {tr("Bedrijf toevoegen")}
          </button>
        </div>
      </ModalBody>
    </Modal>
  );
}

export function FileModal({
  path,
  close,
}: {
  path: string;
  close: () => void;
}) {
  const name = path.split("/").pop() || tr("Bestand");
  return (
    <Modal
      title={name}
      width="file"
      scroll="body"
      close={close}
      className="rz-overlays__file"
      header={
        <span className="rz-overlays__filename rz-mono rz-ellipsis">
          {name}
        </span>
      }
    >
      <FileViewer path={path} />
    </Modal>
  );
}

// The one place where shortcuts are content. Everywhere else they live in a tooltip.
// Not a dialog on purpose: the shortcuts keep working while the sheet is open (App skips them under a dialog).
export function ShortcutSheet({ close }: { close: () => void }) {
  const rows: [string, string[]][] = [
    [tr("Bedrijf wisselen"), ["⌘⇧[", "⌘⇧]"]],
    [tr("Bedrijf openen"), ["⌘⇧N"]],
    [tr("Gesprek kiezen"), ["⌘1–9"]],
    [tr("Gesprek sluiten"), ["⌘W"]],
    [tr("Gesprek ernaast / eronder"), ["⌘D", "⌘⇧D"]],
    [tr("Nieuw gesprek"), ["⌘T"]],
    [tr("Zijbalk tonen of verbergen"), ["⌘⇧S"]],
    [tr("Eerste wachtende"), ["⌘⇧↵"]],
    [tr("Nieuwe taak"), ["⌘N"]],
    [tr("Prioriteitenadvies"), ["⌘P"]],
    [tr("Indienen / terugsturen"), ["⌘↵"]],
    [tr("Profiel"), ["⌘,"]],
    [tr("Sneltoetsen"), ["⌘/"]],
  ];
  return (
    <aside
      className="rz-shortcuts"
      aria-label={tr("Sneltoetsen")}
      data-test="shortcut-sheet"
    >
      <header className="rz-shortcuts__head">
        <h2 className="rz-shortcuts__title">{tr("Alles binnen handbereik")}</h2>
        <IconButton size="sm" label={tr("Sneltoetsen sluiten")} onClick={close}>
          <X size={14} />
        </IconButton>
      </header>
      <dl className="rz-shortcuts__grid">
        {rows.map(([label, keys]) => (
          <div className="rz-shortcuts__row" key={label}>
            <dt className="rz-shortcuts__label">{label}</dt>
            <dd className="rz-shortcuts__keys">
              {keys.map((key, index) => (
                <Fragment key={key}>
                  {index > 0 && <span className="rz-shortcuts__or">/</span>}
                  <kbd className="rz-kbd">{key}</kbd>
                </Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="rz-hint">
        {tr(
          "Zonder open gesprekken: ⌘1 Vandaag · ⌘2 Projecten · ⌘3 Aan het werk. Gebruik Ctrl op Windows.",
        )}
      </p>
    </aside>
  );
}

export function Toasts({
  error,
  notice,
  status = "",
  closeError,
}: {
  error: string;
  notice: string;
  // A passing state such as reconnecting: no close button, it goes away by itself.
  status?: string;
  closeError: () => void;
}) {
  return (
    <>
      {status && (
        <Toast className="rz-overlays__toast" data-test="toast-status">
          <StatusDot tone="warn" className="rz-overlays__toast-dot" />
          {status}
        </Toast>
      )}
      {error && (
        <Toast
          tone="error"
          wrap
          className="rz-overlays__toast"
          data-test="toast-error"
          onClose={closeError}
        >
          <StatusDot tone="warn" className="rz-overlays__toast-dot" />
          {translateMessage(
            error.replace(/^Error invoking remote method '[^']+': Error: /, ""),
          )}
        </Toast>
      )}
      {notice && (
        <Toast className="rz-overlays__toast" data-test="toast-notice">
          <Check
            size={14}
            className="rz-overlays__toast-check"
            aria-hidden="true"
          />
          {notice}
        </Toast>
      )}
    </>
  );
}
