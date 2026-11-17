import { t as tr } from "../shared/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, FileText, X } from "lucide-react";
import type { Session, SessionFileList } from "../shared/types";
import { api, useWorkbench } from "./model";
import { FileViewer } from "./FileViewer";
import { IconButton, Row, RowText, TextButton } from "./rz";

export function useSessionFiles(session: Session) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SessionFileList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setOpen(false);
    setResult(null);
    setError("");
  }, [session.id]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api<SessionFileList>("session.files", {
          id: session.id,
        });
        if (!disposed) {
          setResult(value);
          setError("");
        }
      } catch (e) {
        if (!disposed)
          setError(
            e instanceof Error ? e.message : tr("Bestanden ophalen lukt niet."),
          );
      } finally {
        if (!disposed) timer = setTimeout(refresh, open ? 3000 : 8000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [session.id, open]);
  return { open, setOpen, result, error };
}

// "3", "200+" when the overview is capped, "!" when fetching failed, nothing while loading or empty.
export const countText = (state: ReturnType<typeof useSessionFiles>) =>
  state.result
    ? state.result.files.length
      ? `${state.result.files.length}${state.result.truncated ? "+" : ""}`
      : ""
    : state.error
      ? "!"
      : "";

export function SessionFilesButton({
  state,
}: {
  state: ReturnType<typeof useSessionFiles>;
}) {
  const count = countText(state);
  return (
    <IconButton
      className="rz-session-files__toggle"
      label={tr("Bestanden")}
      title={
        count && count !== "!"
          ? tr("Bestanden bekijken · {0}", count)
          : tr("Bestanden bekijken")
      }
      data-test="session-files-toggle"
      aria-expanded={state.open}
      onClick={() => state.setOpen(!state.open)}
    >
      <FileText size={15} />
      {count && (
        <span className="rz-session-files__count" aria-hidden="true">
          {count}
        </span>
      )}
    </IconButton>
  );
}

const FileTile = () => (
  <span className="rz-session-files__tile" aria-hidden="true">
    <FileText size={13} />
  </span>
);

export function SessionFilesPanel({
  session,
  state,
}: {
  session: Session;
  state: ReturnType<typeof useSessionFiles>;
}) {
  const { run } = useWorkbench();
  const [selected, setSelected] = useState("");
  const headingId = useId();
  const picker = useRef<HTMLDetailsElement>(null);
  const files = state.result?.files || [];
  useEffect(() => {
    if (!files.some((f) => f.path === selected))
      setSelected(files[0]?.path || "");
  }, [files, selected]);
  const file = files.find((f) => f.path === selected) || files[0];
  return (
    <aside
      className="rz-session-files"
      data-test="session-files-panel"
      aria-labelledby={headingId}
    >
      <header className="rz-session-files__head">
        <h3 className="rz-session-files__title" id={headingId}>
          {tr("Bestanden")}
        </h3>
        <IconButton
          size="sm"
          label={tr("Bestanden sluiten")}
          onClick={() => state.setOpen(false)}
        >
          <X size={14} />
        </IconButton>
      </header>
      <p className="rz-session-files__help">
        {tr(
          "Bestanden gewijzigd tijdens dit gesprek, gekoppelde bestanden en eerdere resultaten. Werkmappen kunnen gedeeld zijn.",
        )}
      </p>
      {state.error && (
        <p
          className="rz-error rz-error--block rz-session-files__error"
          role="alert"
        >
          {state.error}
        </p>
      )}
      {state.result?.unavailable && (
        <p className="rz-session-files__help">
          {tr(
            "Een map is niet bereikbaar. Beschikbare bestanden staan hieronder.",
          )}
        </p>
      )}
      {files.length ? (
        <>
          <details
            className="rz-session-files__picker"
            data-test="session-files-picker"
            ref={picker}
          >
            <summary className="rz-session-files__current">
              <FileTile />
              <span className="rz-session-files__name">{file?.name}</span>
              <span className="rz-session-files__total" aria-hidden="true">
                {files.length}
                {state.result?.truncated ? "+" : ""}
              </span>
              <ChevronDown
                className="rz-session-files__chevron"
                size={12}
                aria-hidden="true"
              />
            </summary>
            <div
              className="rz-session-files__list"
              data-test="session-files-list"
              role="group"
              aria-label={tr("Bestanden in dit gesprek")}
            >
              {files.map((item) => (
                <Row
                  as="button"
                  size="sm"
                  cols="28px minmax(0, 1fr)"
                  className="rz-session-files__file"
                  key={item.path}
                  selected={file?.path === item.path}
                  title={item.path}
                  onClick={() => {
                    setSelected(item.path);
                    if (picker.current) picker.current.open = false;
                  }}
                >
                  <FileTile />
                  <RowText
                    title={item.name}
                    meta={
                      (item.source === "linked"
                        ? tr("Gekoppeld aan gesprek")
                        : item.source === "output"
                          ? tr("Resultaatmap")
                          : tr("Werkmap · gewijzigd tijdens gesprek")) +
                      (item.relativePath !== item.name
                        ? ` · ${item.relativePath}`
                        : "")
                    }
                  />
                </Row>
              ))}
            </div>
          </details>
          {state.result?.truncated && (
            <p className="rz-session-files__help">
              {tr(
                "Het overzicht is begrensd. Open de map voor alle bestanden.",
              )}
            </p>
          )}
          <div className="rz-session-files__viewer">
            <FileViewer
              path={file?.path}
              refreshKey={file ? `${file.modifiedAt}:${file.size}` : ""}
            />
          </div>
        </>
      ) : (
        <div className="rz-session-files__empty">
          <FileTile />
          <strong>
            {state.result
              ? tr("Nog geen bestanden")
              : state.error
                ? tr("Bestanden niet beschikbaar")
                : tr("Bestanden ophalen…")}
          </strong>
          <p>
            {tr(
              "Nieuwe en gewijzigde bestanden in de werkmap verschijnen hier automatisch.",
            )}
          </p>
        </div>
      )}
      {session.cwd && (
        <footer className="rz-session-files__foot">
          <TextButton
            tone="meta"
            onClick={() => {
              void run(() => window.werk.openPath(session.cwd));
            }}
          >
            {tr("Werkmap openen ↗")}
          </TextButton>
        </footer>
      )}
    </aside>
  );
}
