import { t as tr } from "../shared/i18n";
import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalTheme } from "../shared/terminal-theme";
import { localFileUrls, terminalPaths } from "../shared/terminal-paths";
import type { TerminalFrame } from "../shared/types";
import { useWorkbench } from "./model";
export function Terminal({
  id,
  alive,
  onError,
}: {
  id: string;
  alive: boolean;
  onError: (error: string) => void;
}) {
  const { prefs } = useWorkbench();
  const { terminalPreset, terminalFont, terminalFontSize, terminalLineHeight } =
    prefs.profile;
  const surround = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null),
    error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      ready = false,
      sequence = -1,
      syncs = 0,
      retry: ReturnType<typeof setTimeout> | undefined;
    const buffer: { sequence: number; data: string }[] = [];
    const colorMode = () =>
      document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const term = new Xterm({
      fontFamily:
        terminalFont === "plex"
          ? '"IBM Plex Mono", Menlo, monospace'
          : "ui-monospace, Menlo, monospace",
      fontSize: terminalFontSize,
      lineHeight: terminalLineHeight,
      fontWeight: terminalPreset === "classic" ? "normal" : 400,
      fontWeightBold: terminalPreset === "classic" ? "bold" : 500,
      cursorBlink: true,
      cursorStyle: terminalPreset === "classic" ? "block" : "bar",
      cursorWidth: 2,
      scrollback: 3000,
      convertEol: false,
      allowProposedApi: true,
      theme: terminalTheme(terminalPreset, colorMode()),
    });
    // Classic is the Rustig --term-bg token (css). The other presets bring their own screen colour: the frame
    // takes it over, so no preset shows a seam around xterm.
    const paint = () => {
      if (surround.current)
        surround.current.style.background =
          terminalPreset === "classic"
            ? ""
            : terminalTheme(terminalPreset, colorMode()).background;
    };
    const theme = () => {
      term.options.theme = terminalTheme(terminalPreset, colorMode());
      paint();
    };
    paint();
    // The app process answers foreground/background probes, even without this
    // terminal mounted. Suppress duplicate responses from visible xterm panes.
    for (const slot of [10, 11])
      term.parser.registerOscHandler(slot, (data) =>
        data.split(";").every((value) => value === "?"),
      );
    window.addEventListener("benchdesk-theme", theme);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    const frameElement = surround.current!;
    const insertPaths = (paths: string[]) => {
      if (disposed || !alive) return;
      const text = terminalPaths(paths);
      if (!text)
        throw new Error(
          tr(
            "Het lokale bestandspad is niet beschikbaar. Gebruik de desktop-app of kopieer het volledige pad.",
          ),
        );
      term.focus();
      term.paste(text);
    };
    const filePaths = (data: DataTransfer) =>
      Array.from(data.files).map(
        (file) => window.werk.pathForFile?.(file) || "",
      );
    const isFileDrag = (event: DragEvent) =>
      !!event.dataTransfer &&
      (Array.from(event.dataTransfer.types).includes("Files") ||
        Array.from(event.dataTransfer.types).includes("text/uri-list"));
    const dragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = alive ? "copy" : "none";
      if (alive) frameElement.dataset.fileDrop = "true";
    };
    const dragLeave = (event: DragEvent) => {
      if (!frameElement.contains(event.relatedTarget as Node | null))
        delete frameElement.dataset.fileDrop;
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      delete frameElement.dataset.fileDrop;
      if (!alive) return;
      try {
        const paths = filePaths(event.dataTransfer!);
        if (paths.some((path) => !path))
          throw new Error(
            tr(
              "Het lokale bestandspad is niet beschikbaar. Gebruik de desktop-app of kopieer het volledige pad.",
            ),
          );
        insertPaths(
          paths.length
            ? paths
            : localFileUrls(event.dataTransfer!.getData("text/uri-list")),
        );
      } catch (e) {
        error.current(tr((e as Error).message));
      }
    };
    // Capture ahead of xterm so Finder filenames don't also paste as bare names.
    // Normal text still follows xterm's paste API, including bracketed-paste mode.
    const paste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const files = filePaths(data);
      const urls = localFileUrls(data.getData("text/uri-list"));
      const plain = data.getData("text/plain");
      if (!window.werk.clipboardFiles && !files.length && !urls.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!alive) return;
      void (async () => {
        try {
          const native = window.werk.clipboardFiles
            ? await window.werk.clipboardFiles()
            : [];
          if (disposed) return;
          if (native.length) insertPaths(native);
          else if (files.length && files.every(Boolean)) insertPaths(files);
          else if (urls.length) insertPaths(urls);
          else if (files.length)
            throw new Error(
              tr(
                "Het lokale bestandspad is niet beschikbaar. Gebruik de desktop-app of kopieer het volledige pad.",
              ),
            );
          else term.paste(plain);
        } catch (e) {
          if (!disposed) error.current(tr((e as Error).message));
        }
      })();
    };
    frameElement.addEventListener("dragover", dragOver);
    frameElement.addEventListener("dragleave", dragLeave);
    frameElement.addEventListener("drop", drop);
    frameElement.addEventListener("paste", paste, true);
    const unsub = window.werk.onEvent((event) => {
      // Output sent while the connection was down is lost: draw the stored screen again.
      if (event.type === "reconnected") return sync();
      if (event.type !== "terminal" || event.sessionId !== id) return;
      if (!ready) {
        buffer.push(event);
        // A screen that never arrives must not grow the buffer without end; a fresh screen covers it.
        if (buffer.length > 5000) {
          buffer.length = 0;
          sync();
        }
      } else if (event.sequence > sequence) {
        sequence = event.sequence;
        term.write(event.data);
      }
    });
    const resize = () => {
      if (disposed || !ready) return;
      try {
        fit.fit();
        if (alive)
          void window.werk
            .call("session.resize", { id, cols: term.cols, rows: term.rows })
            .catch(() => {});
      } catch {}
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = term.onData((data) => {
      if (alive)
        void window.werk
          .call("session.write", { id, data })
          .catch((e) => error.current(e.message));
    });
    // The stored screen, then the live output after it. Retried a few times: a pane whose first fetch failed
    // (runner busy or connection dropped) stayed blank until you navigated away.
    function sync(attempt = 0) {
      const run = ++syncs;
      clearTimeout(retry);
      void window.werk
        .call<TerminalFrame>("session.screen", { id })
        .then((frame) => {
          if (disposed || run !== syncs) return;
          if (ready) {
            ready = false;
            term.reset();
          }
          term.resize(frame.cols, frame.rows);
          sequence = frame.sequence;
          term.write(frame.screen, () => {
            if (disposed || run !== syncs) return;
            ready = true;
            for (const event of buffer)
              if (event.sequence > sequence) {
                sequence = event.sequence;
                term.write(event.data);
              }
            buffer.length = 0;
            resize();
          });
        })
        .catch((e) => {
          if (disposed || run !== syncs) return;
          if (attempt < 3)
            retry = setTimeout(() => sync(attempt + 1), 1000 * (attempt + 1));
          else error.current(e.message);
        });
    }
    sync();
    return () => {
      disposed = true;
      clearTimeout(retry);
      unsub();
      observer.disconnect();
      input.dispose();
      frameElement.removeEventListener("dragover", dragOver);
      frameElement.removeEventListener("dragleave", dragLeave);
      frameElement.removeEventListener("drop", drop);
      frameElement.removeEventListener("paste", paste, true);
      delete frameElement.dataset.fileDrop;
      window.removeEventListener("benchdesk-theme", theme);
      term.dispose();
    };
  }, [
    id,
    alive,
    terminalPreset,
    terminalFont,
    terminalFontSize,
    terminalLineHeight,
  ]);
  // Frame (Rustig: --term-bg, 1px --term-line above and below, the design's padding) around an unpadded
  // screen: the fit addon measures the parent of xterm, so padding on that parent would cost columns and rows.
  // Font, size and line height stay the user's own preferences; nothing here sets them.
  return (
    <div
      className="rz-workplace-term"
      data-test="terminal-host"
      data-preset={terminalPreset}
      ref={surround}
      role="group"
      aria-label={tr("Volledige bediening")}
    >
      <div className="rz-workplace-term__screen" ref={host} />
    </div>
  );
}
