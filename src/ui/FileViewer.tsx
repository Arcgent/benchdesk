import { t as tr, translateMessage } from "../shared/i18n";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type OlHTMLAttributes,
} from "react";
import { ExternalLink, FileText } from "lucide-react";
import type { Artifact } from "../shared/types";
import { useWorkbench } from "./model";
import { Button, Empty, IconButton, cx } from "./rz";

// The highlighted source line, shared with the Markdown blocks below. `pick` is absent in hosts that only show a file.
const MarkContext = createContext<{
  line: number;
  pick?: (line: number) => void;
} | null>(null);
const plugins = [remarkGfm];
const isMarkdown = (path?: string) => /\.(md|markdown)$/i.test(path || "");
const baseName = (path?: string) =>
  path?.replace(/\/$/, "").split("/").pop() || "";

// Only LEAF blocks carry data-line (decision C22): a list, a quote or a table never does, so `[data-line="4"]`
// matches one element. A list item with paragraphs leaves the marking to those paragraphs; a tight item that
// holds a nested block stops right before it.
const nestedBlocks = new Set(["ul", "ol", "pre", "blockquote", "table"]);
type BlockTag =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "li"
  | "pre"
  | "tr";
function lines(node: ExtraProps["node"], tag: BlockTag) {
  const start = node?.position?.start.line;
  if (!node || !start) return null;
  let end = node.position?.end.line ?? start;
  if (tag === "li") {
    let nested = 0;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "p") return null;
      if (!nested && nestedBlocks.has(child.tagName))
        nested = child.position?.start.line ?? 0;
    }
    if (nested) end = nested - 1;
  }
  return end < start ? null : { start, end };
}
const block = (tag: BlockTag) =>
  function Block({ node, ...rest }: HTMLAttributes<HTMLElement> & ExtraProps) {
    const mark = useContext(MarkContext),
      at = lines(node, tag);
    if (!mark || !at) return createElement(tag, rest);
    const on = mark.line >= at.start && mark.line <= at.end,
      pick = mark.pick;
    return createElement(tag, {
      ...rest,
      "data-line": at.start,
      "data-marked": on ? "" : undefined,
      "data-test": on ? "highlighted" : undefined,
      onClick: pick
        ? (event: MouseEvent<HTMLElement>) => {
            event.stopPropagation();
            pick(at.start);
          }
        : undefined,
    });
  };
// Links only ever open http(s), through the app; images are never loaded (alt text only).
function ProseLink({
  href,
  children,
}: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  const { run } = useWorkbench();
  return (
    <button
      type="button"
      className="rz-prose__link"
      onClick={(event) => {
        event.stopPropagation();
        if (href && /^https?:\/\//i.test(href))
          void run(() => window.werk.openPath(href));
      }}
    >
      {children}
    </button>
  );
}
// The numbers are drawn by css counters (so a highlighted item is one full-width block): honour `start`.
function ProseOrdered({
  node,
  start,
  style,
  ...rest
}: OlHTMLAttributes<HTMLOListElement> & ExtraProps) {
  return (
    <ol
      {...rest}
      start={start}
      style={{ ...style, counterReset: `rz-prose-li ${(start ?? 1) - 1}` }}
    />
  );
}
const components: Components = {
  h1: block("h1"),
  h2: block("h2"),
  h3: block("h3"),
  h4: block("h4"),
  h5: block("h5"),
  h6: block("h6"),
  p: block("p"),
  li: block("li"),
  pre: block("pre"),
  tr: block("tr"),
  ol: ProseOrdered,
  a: ProseLink,
  img: ({ alt }) => <span>{alt}</span>,
};

// Hosted by Review (right pane), AppOverlays.FileModal and SessionFilesPanel. Hosts only size it: the root fills a
// grid cell or a flex column on its own; `className` is for the host's frame (border, min-height).
export function FileViewer({
  path,
  line = 0,
  refreshKey,
  files = [],
  onSelect,
  onLine,
  drag,
  className,
}: {
  path?: string;
  line?: number;
  refreshKey?: string;
  files?: Artifact[];
  onSelect?: (path: string) => void;
  onLine?: (line: number) => void; // a click on a line / block moves the highlight; without it lines are inert
  drag?: boolean; // the tab bar is the top of the window (Beoordelen): it may move the window
  className?: string;
}) {
  const { run } = useWorkbench();
  const [reading, setReading] = useState(true);
  const [preview, setPreview] = useState<{
      kind: string;
      content: string;
      name: string;
    } | null>(null),
    [error, setError] = useState("");
  const body = useRef<HTMLDivElement>(null),
    revealed = useRef(false);
  const previousPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    let current = true;
    if (previousPath.current !== path) setPreview(null);
    previousPath.current = path;
    setError("");
    if (path)
      void window.werk
        .preview(path)
        .then((value) => {
          if (current) setPreview(value);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [path, refreshKey]);
  // Bring the highlighted line into view inside the viewer. A line that is already visible stays where it is
  // (a click on it must not make the text jump). When the viewer does not scroll itself (stacked layout) the
  // page scrolls instead, except for the very first highlight: opening the page must not jump past the criteria.
  useEffect(() => {
    const box = body.current,
      node = box?.querySelector<HTMLElement>("[data-marked]");
    if (!box || !node) return;
    const a = node.getBoundingClientRect(),
      b = box.getBoundingClientRect();
    if (box.scrollHeight > box.clientHeight + 1) {
      if (a.top < b.top || a.bottom > b.bottom)
        box.scrollTop += a.top - b.top - (box.clientHeight - a.height) / 2;
    } else if (revealed.current) node.scrollIntoView({ block: "nearest" });
    revealed.current = true;
  }, [line, preview, reading]);
  const markdown = preview?.kind === "text" && isMarkdown(path),
    text = preview?.kind === "text" ? preview.content : "";
  const mark = useMemo(() => ({ line, pick: onLine }), [line, onLine]);
  // react-markdown parses on every render: keep the tree while only the highlight moves (context reaches the blocks).
  const prose = useMemo(
    () => (
      <Markdown remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    ),
    [text],
  );
  const source = useMemo(() => text.split("\n"), [text]);
  const open = () => {
    if (path) void run(() => window.werk.openPath(path));
  };
  return (
    <section
      className={cx("rz-fileviewer", className)}
      data-test="file-viewer"
      aria-label={baseName(path) || tr("Bestanden")}
    >
      <header className={cx("rz-fileviewer__bar", drag && "rz-drag")}>
        {files.length > 0 && (
          <div
            className="rz-fileviewer__tabs rz-nodrag"
            role="group"
            aria-label={tr("Bestanden")}
          >
            {files.map((file) => (
              <button
                type="button"
                key={file.id}
                className="rz-fileviewer__tab"
                aria-pressed={path === file.path}
                title={file.name}
                onClick={() => onSelect?.(file.path)}
              >
                {file.name}
              </button>
            ))}
            {path && !files.some((file) => file.path === path) && (
              <span className="rz-fileviewer__tab" data-current="">
                {baseName(path)}
              </span>
            )}
          </div>
        )}
        <div className="rz-fileviewer__tools">
          {markdown && (
            <div
              className="rz-texttabs"
              role="group"
              aria-label={tr("Bestandsweergave")}
            >
              <button
                type="button"
                className="rz-texttab"
                aria-pressed={reading}
                onClick={() => setReading(true)}
              >
                {tr("Leesweergave")}
              </button>
              <button
                type="button"
                className="rz-texttab"
                aria-pressed={!reading}
                onClick={() => setReading(false)}
              >
                {tr("Bron")}
              </button>
            </div>
          )}
          {path && (
            <IconButton
              size="sm"
              className="rz-fileviewer__open"
              label={tr("Openen")}
              title={tr("Openen in je eigen app")}
              onClick={open}
            >
              <ExternalLink size={14} />
            </IconButton>
          )}
        </div>
      </header>
      <div
        className={cx(
          "rz-fileviewer__body",
          !error &&
            path &&
            preview?.kind === "pdf" &&
            "rz-fileviewer__body--flush",
        )}
        ref={body}
      >
        {error ? (
          <p className="rz-fileviewer__note rz-fileviewer__note--error">
            {translateMessage(error)}
          </p>
        ) : !path ? (
          <Empty
            className="rz-fileviewer__empty"
            icon={<FileText size={24} />}
            title={tr("Het bewijs naast je beoordeling.")}
          >
            {tr(
              "Klik op een bestand of bewijsverwijzing om het hier te bekijken.",
            )}
          </Empty>
        ) : !preview ? (
          <p className="rz-fileviewer__note">{tr("Bestand openen…")}</p>
        ) : markdown && reading ? (
          <MarkContext.Provider value={mark}>
            <article
              className="rz-prose"
              data-test="markdown-preview"
              data-pick={onLine ? "" : undefined}
            >
              {prose}
            </article>
          </MarkContext.Provider>
        ) : preview.kind === "text" ? (
          <div
            className="rz-fileviewer__source"
            data-test="source-file"
            data-pick={onLine ? "" : undefined}
            style={
              {
                "--rz-fileviewer-no": `${String(source.length).length}ch`,
              } as CSSProperties
            }
          >
            {source.map((text, index) => (
              <div
                className="rz-fileviewer__line"
                key={index}
                data-line={index + 1}
                data-marked={index + 1 === line ? "" : undefined}
                data-test={index + 1 === line ? "highlighted" : undefined}
                data-heading={
                  markdown && /^#{1,6} /.test(text) ? "" : undefined
                }
                onClick={onLine ? () => onLine(index + 1) : undefined}
              >
                <span className="rz-fileviewer__no" aria-hidden="true">
                  {index + 1}
                </span>
                <code>{text || " "}</code>
              </div>
            ))}
          </div>
        ) : preview.kind === "image" ? (
          <img
            className="rz-fileviewer__image"
            src={preview.content}
            alt={preview.name}
          />
        ) : preview.kind === "pdf" ? (
          <iframe
            className="rz-fileviewer__frame"
            title={preview.name}
            src={preview.content}
          />
        ) : (
          <Empty
            className="rz-fileviewer__empty"
            title={tr("Open dit bestand in je eigen app.")}
            action={
              <Button iconEnd={<ExternalLink size={13} />} onClick={open}>
                {tr("Bestand openen")}
              </Button>
            }
          >
            {preview.content}
          </Empty>
        )}
      </div>
    </section>
  );
}
