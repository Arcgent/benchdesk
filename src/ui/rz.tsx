// Rustig shared primitives. Foundation-owned and FROZEN after the foundation: area packages consume these and never
// edit this file (need something else? build it under your own rz-<area> block and log it in your promote note).
// Every primitive takes `className` and `data-test`; all other DOM attributes (data-*-id, aria-*, style, handlers)
// pass through to the root element. Css lives in rustig/primitives.css. API reference: tmp/rustig/notes/_primitives-api.md.
import { t as tr } from "../shared/i18n";
import {
  Fragment,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  Check as CheckIcon,
  ChevronDown,
  Columns3,
  LayoutGrid,
  List,
  PanelLeft,
  Plus,
  X,
} from "lucide-react";
import { monogram, type Tone } from "./primitives";

export type { Tone };
type Test = { "data-test"?: string };
type Falsy = false | null | undefined | "";
export const cx = (...parts: (string | Falsy)[]) =>
  parts.filter(Boolean).join(" ");
const vars = (values: Record<string, string | undefined>) =>
  values as CSSProperties;

// ---- Page frame -------------------------------------------------------------------------------------------------
// The shell (F4) provides this; without a provider the "Zijbalk tonen" button simply never renders.
export const ShellContext = createContext<{
  sidebarOpen: boolean;
  showSidebar: () => void;
} | null>(null);
export function PageShell({
  width = "normal",
  composer,
  children,
  className,
  scrollRef,
  ...rest
}: {
  width?: "normal" | "wide" | "full";
  composer?: ReactNode;
  children: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
} & Test &
  Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const shell = useContext(ShellContext),
    dock = useRef<HTMLDivElement>(null);
  // Toasts sit in App, outside this subtree: lift them above the docked composer through a root variable.
  useLayoutEffect(() => {
    const node = dock.current;
    if (!node) return;
    const root = document.documentElement;
    const lift = () =>
      root.style.setProperty("--rz-toast-bottom", `${node.offsetHeight + 8}px`);
    lift();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(lift);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--rz-toast-bottom");
    };
  }, [!!composer]);
  return (
    <div className="rz-main" {...rest}>
      {shell && !shell.sidebarOpen && (
        <IconButton
          className="rz-main__side-toggle rz-nodrag"
          label={tr("Zijbalk tonen")}
          onClick={shell.showSidebar}
        >
          <PanelLeft size={16} />
        </IconButton>
      )}
      <div className="rz-scroll" ref={scrollRef}>
        <div
          className={cx(
            "rz-page",
            width !== "normal" && `rz-page--${width}`,
            !!composer && "rz-page--composer",
            className,
          )}
        >
          {children}
        </div>
      </div>
      {composer && (
        <div className="rz-composer-dock" ref={dock}>
          {composer}
        </div>
      )}
    </div>
  );
}
export function Crumbs({
  items,
  className,
  ...rest
}: {
  items: { label: ReactNode; onClick?: () => void }[];
} & Test &
  HTMLAttributes<HTMLElement>) {
  return (
    <nav
      className={cx("rz-crumbs", className)}
      aria-label={tr("Kruimelpad")}
      {...rest}
    >
      {items.map((item, index) => (
        <span className="rz-crumbs__item" key={index}>
          {index > 0 && <span aria-hidden="true">/</span>}
          {item.onClick ? (
            <button
              type="button"
              className="rz-crumbs__link"
              onClick={item.onClick}
            >
              {item.label}
            </button>
          ) : (
            <span
              aria-current={index === items.length - 1 ? "page" : undefined}
            >
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
export function PageHead({
  title,
  titleAs: Title = "h1",
  srTitle,
  variant,
  eyebrow,
  crumbs,
  badge,
  meta,
  actions,
  children,
  className,
  ...rest
}: {
  title: ReactNode;
  titleAs?: "h1" | "h2";
  srTitle?: string; // hidden <h1> when the visible title is a sentence (smokes wait for heading "Vandaag")
  variant?: "sentence" | "review";
  eyebrow?: ReactNode;
  crumbs?: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode; // lead text, meta line: rendered under the title row
} & Test &
  Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <header className={cx("rz-headblock", className)} {...rest}>
      {srTitle && <h1 className="rz-sr">{srTitle}</h1>}
      {crumbs}
      {eyebrow && <div className="rz-head__meta">{eyebrow}</div>}
      <div className="rz-head">
        <div className="rz-head__text">
          <div className="rz-head__title">
            {badge}
            <Title className={cx("rz-h1", variant && `rz-h1--${variant}`)}>
              {title}
            </Title>
          </div>
          {meta && <div className="rz-head__meta">{meta}</div>}
        </div>
        {actions && <div className="rz-head__actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

// ---- Tabs, view switch ------------------------------------------------------------------------------------------
export type TabItem<T extends string = string> = {
  id: T;
  label: ReactNode;
  count?: number | string;
  title?: string;
  "data-test"?: string;
};
// semantics="tabs": tablist/tab + arrow keys (content below is the panel). semantics="buttons": a filter made of
// aria-pressed buttons (canvas company filter), reachable with Tab like any button row.
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  semantics = "tabs",
  variant,
  className,
  ...rest
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  semantics?: "tabs" | "buttons";
  variant?: "bar";
  className?: string;
} & Test &
  Omit<HTMLAttributes<HTMLDivElement>, "onChange">) {
  const asTabs = semantics === "tabs";
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!asTabs) return;
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const at = tabs.findIndex((t) => t.id === value);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : step
            ? (at + step + tabs.length) % tabs.length
            : -1;
    if (next < 0 || !tabs[next]) return;
    event.preventDefault();
    onChange(tabs[next].id);
    event.currentTarget
      .querySelectorAll<HTMLElement>('[role="tab"]')
      [next]?.focus();
  };
  return (
    <div
      className={cx("rz-tabs", variant && `rz-tabs--${variant}`, className)}
      role={asTabs ? "tablist" : "group"}
      aria-label={label}
      onKeyDown={keys}
      {...rest}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            className="rz-tab"
            title={tab.title}
            data-test={tab["data-test"]}
            onClick={() => onChange(tab.id)}
            {...(asTabs
              ? {
                  role: "tab",
                  "aria-selected": active,
                  tabIndex: active ? 0 : -1,
                }
              : { "aria-pressed": active })}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="rz-tab__count" aria-hidden="true">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
// README: the list/board choice is remembered under new keys; the old keys are read once so nobody loses a choice.
const oldViewKeys: Record<string, string> = {
  "projectrustig.view": "projectpro.view",
  "projectenrustig.view": "projecten.view",
};
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
export function useSavedView(
  key: "projectrustig.view" | "projectenrustig.view" | (string & {}),
  fallback: string,
) {
  const save = (next: string) => {
    try {
      localStorage.setItem(key, next);
    } catch {}
  };
  const [view, set] = useState(
    () =>
      stored(key) || (oldViewKeys[key] && stored(oldViewKeys[key])) || fallback,
  );
  // One-time migration: a choice found under the old key moves to the new key.
  useEffect(() => {
    if (stored(key) === null && view !== fallback) save(view);
  }, []);
  return [
    view,
    (next: string) => {
      set(next);
      save(next);
    },
  ] as const;
}
export function ViewSwitch({
  view,
  set,
  board = false,
  className,
  ...rest
}: {
  view: string;
  set: (view: string) => void;
  board?: boolean; // Project: "Bord". Projecten: "Kaarten".
} & Test &
  HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("rz-viewswitch", className)}
      role="group"
      aria-label={tr("Weergave")}
      {...rest}
    >
      <IconButton
        label={tr("Lijst")}
        pressed={view === "list"}
        onClick={() => set("list")}
      >
        <List size={15} />
      </IconButton>
      <IconButton
        label={board ? tr("Bord") : tr("Kaarten")}
        pressed={view !== "list"}
        onClick={() => set(board ? "board" : "cards")}
      >
        {board ? <Columns3 size={15} /> : <LayoutGrid size={15} />}
      </IconButton>
    </div>
  );
}

// ---- Sections and rows ------------------------------------------------------------------------------------------
export function Section({
  tight,
  className,
  children,
  ...rest
}: { tight?: boolean } & Test & HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cx("rz-section", tight && "rz-section--tight", className)}
      {...rest}
    >
      {children}
    </section>
  );
}
export function SectionLabel({
  children,
  dot,
  right,
  tall,
  as: Tag = "div",
  className,
  ...rest
}: {
  children: ReactNode;
  dot?: Tone; // leading 6px dot: "Wacht op jou" = accent
  right?: ReactNode;
  tall?: boolean;
  as?: "div" | "h2" | "h3";
} & Test &
  HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cx(
        "rz-label",
        right !== undefined && "rz-label--split",
        tall && "rz-label--tall",
        className,
      )}
      {...rest}
    >
      <span className="rz-label__text">
        {dot && <i className="rz-dot" data-tone={dot} aria-hidden="true" />}
        {children}
      </span>
      {right !== undefined && <span className="rz-label__right">{right}</span>}
    </Tag>
  );
}
type RowOwn = {
  size?: "lg" | "md" | "task" | "sm" | "xs";
  cols?: string; // grid-template-columns; default 28px minmax(0,1fr) auto
  done?: boolean; // strike + opacity .55
  selected?: boolean;
  quiet?: boolean; // no pointer cursor (a row that is not clickable as a whole)
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
} & Test;
// `as` is required on purpose: a row with its own buttons inside (check, "Beoordelen") must be a div, a row
// that is one action must be a button or a link. Nested buttons are invalid html and break keyboard use.
export function Row(
  props:
    | (RowOwn & { as: "button" } & Omit<
          ButtonHTMLAttributes<HTMLButtonElement>,
          keyof RowOwn
        >)
    | (RowOwn & { as: "div" } & Omit<
          HTMLAttributes<HTMLDivElement>,
          keyof RowOwn
        >)
    | (RowOwn & { as: "a"; href: string } & Omit<
          HTMLAttributes<HTMLAnchorElement>,
          keyof RowOwn
        >),
) {
  const { as, size, cols, done, selected, quiet, className, style, ...rest } =
    props;
  const shared = {
    className: cx(
      "rz-row",
      size && `rz-row--${size}`,
      quiet && "rz-row--static",
      className,
    ),
    style: cols ? { ...vars({ "--rz-row-cols": cols }), ...style } : style,
    "data-done": done ? "" : undefined,
    "data-selected": selected ? "" : undefined,
  };
  if (as === "button")
    return (
      <button
        type="button"
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
        {...shared}
        aria-pressed={selected}
      />
    );
  if (as === "a")
    return <a {...(rest as HTMLAttributes<HTMLAnchorElement>)} {...shared} />;
  return <div {...(rest as HTMLAttributes<HTMLDivElement>)} {...shared} />;
}
export function RowText({
  title,
  meta,
  wrap,
  titleProps,
  className,
  ...rest
}: {
  title: ReactNode;
  meta?: ReactNode;
  wrap?: boolean;
  titleProps?: HTMLAttributes<HTMLSpanElement> & Test;
} & Test &
  Omit<HTMLAttributes<HTMLSpanElement>, "title">) {
  return (
    <span className={cx("rz-row__text", className)} {...rest}>
      <span
        {...titleProps}
        className={cx(
          "rz-row__title",
          wrap && "rz-row__title--wrap",
          titleProps?.className,
        )}
      >
        {title}
      </span>
      {meta !== undefined && meta !== "" && (
        <span className="rz-row__meta">{meta}</span>
      )}
    </span>
  );
}
export function RowEnd({
  className,
  children,
  ...rest
}: Test & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("rz-row__end", className)} {...rest}>
      {children}
    </span>
  );
}
// Deadline text: late = --warn ("Verlopen · di 15 sep").
export function Due({
  late,
  className,
  children,
  ...rest
}: { late?: boolean } & Test & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx("rz-due", className)}
      data-late={late ? "" : undefined}
      {...rest}
    >
      {children}
    </span>
  );
}

// ---- Status, identity, progress ---------------------------------------------------------------------------------
export function StatusDot({
  tone,
  label,
  size,
  accentText,
  className,
  ...rest
}: {
  tone: Tone;
  label?: ReactNode; // without a label the dot is decorative (aria-hidden)
  size?: 12; // 12px text: Vandaag "Verdergaan", pane header
  accentText?: boolean; // "● Actief" on the Project meta line
} & Test &
  HTMLAttributes<HTMLSpanElement>) {
  if (label === undefined)
    return (
      <i
        className={cx("rz-dot", className)}
        data-tone={tone}
        aria-hidden="true"
        {...rest}
      />
    );
  return (
    <span
      className={cx(
        "rz-status",
        size === 12 && "rz-status--12",
        accentText && "rz-status--accent",
        className,
      )}
      data-tone={tone}
      {...rest}
    >
      <i className="rz-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
// Round: people and assistants. provider "codex" | "claude" get their fixed tint and "Cx" / "Cl";
// anything else shows the initials of `name` on the user tint (or `tint`).
export function Avatar({
  provider,
  name = "",
  tint,
  size = 28,
  className,
  style,
  ...rest
}: {
  provider?: string;
  name?: string;
  tint?: string;
  size?: 18 | 22 | 28 | 30;
} & Test &
  HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx(
        "rz-avatar",
        size !== 28 && `rz-avatar--${size}`,
        className,
      )}
      data-provider={provider}
      style={tint ? { ...vars({ "--tint": tint }), ...style } : style}
      aria-hidden="true"
      {...rest}
    >
      {provider === "codex"
        ? "Cx"
        : provider === "claude"
          ? "Cl"
          : monogram(name)}
    </span>
  );
}
// Square: companies (companyTint) and projects (projectTint).
export function Badge({
  name,
  tint,
  size = 20,
  className,
  style,
  ...rest
}: {
  name: string;
  tint?: string;
  size?: 14 | 18 | 20 | 22 | 24 | 26;
} & Test &
  HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx("rz-badge", size !== 20 && `rz-badge--${size}`, className)}
      style={tint ? { ...vars({ "--tint": tint }), ...style } : style}
      aria-hidden="true"
      {...rest}
    >
      {monogram(name)}
    </span>
  );
}
export function Bar({
  pct,
  tone = "accent",
  mini,
  label,
  valueText,
  className,
  style,
  ...rest
}: {
  pct: number;
  tone?: Tone;
  mini?: boolean; // 56px inline bar on the Project meta line
  label?: string; // with a label it is a progressbar; without one it is decoration
  valueText?: string;
} & Test &
  HTMLAttributes<HTMLSpanElement>) {
  const value = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <span
      className={cx("rz-bar", mini && "rz-bar--mini", className)}
      data-tone={tone}
      style={{ ...vars({ "--pct": `${value}%` }), ...style }}
      {...(label
        ? {
            role: "progressbar",
            "aria-label": label,
            "aria-valuenow": Math.round(value),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuetext": valueText,
          }
        : { "aria-hidden": true })}
      {...rest}
    >
      <i />
    </span>
  );
}

// ---- Buttons ----------------------------------------------------------------------------------------------------
type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "quiet";
  size?: "sm" | "row" | "lg"; // sm 28 ("Inloggen"), row 34 ("Beoordelen"), lg 38 (empty canvas)
  icon?: ReactNode;
  iconEnd?: ReactNode;
  plus?: boolean; // the "+" of "+ Account toevoegen": always an svg, never text
} & Test &
  ButtonHTMLAttributes<HTMLButtonElement>;
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size,
      icon,
      iconEnd,
      plus,
      className,
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(
          "rz-btn",
          `rz-btn--${variant}`,
          size && `rz-btn--${size}`,
          className,
        )}
        {...rest}
      >
        {plus && <Plus size={13} aria-hidden="true" />}
        {icon}
        {children}
        {iconEnd}
      </button>
    );
  },
);
type IconButtonProps = {
  label: string; // accessible name, and the tooltip unless `title` overrides it (e.g. to add a shortcut)
  size?: "lg" | "sm" | "xs"; // 32 / 28 / 22; default 30
  variant?: "side" | "round";
  pressed?: boolean;
} & Test &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">;
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      title,
      size,
      variant,
      pressed,
      className,
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(
          "rz-iconbtn",
          size && `rz-iconbtn--${size}`,
          variant && `rz-iconbtn--${variant}`,
          className,
        )}
        aria-label={label}
        title={title ?? label}
        aria-pressed={pressed}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

// Text actions: "Check-in doen →", "Hervatten →", "Als taak", "Toevoegen" (accent); "Alle taken →", "Sluiten" (meta).
export const TextButton = forwardRef<
  HTMLButtonElement,
  { tone?: "accent" | "meta"; icon?: ReactNode } & Test &
    ButtonHTMLAttributes<HTMLButtonElement>
>(function TextButton(
  { tone, icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("rz-link", tone && `rz-link--${tone}`, className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

// ---- Cards ------------------------------------------------------------------------------------------------------
export function Cards({
  min,
  className,
  style,
  children,
  ...rest
}: { min?: number } & Test & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("rz-cards", className)}
      style={
        min ? { ...vars({ "--rz-card-min": `${min}px` }), ...style } : style
      }
      {...rest}
    >
      {children}
    </div>
  );
}
type CardOwn = {
  variant?: "project" | "board" | "dashed";
  selected?: boolean; // border --text2 (selected goal)
  className?: string;
  children: ReactNode;
} & Test;
export function Card(
  props:
    | (CardOwn & { as: "button" } & Omit<
          ButtonHTMLAttributes<HTMLButtonElement>,
          keyof CardOwn
        >)
    | (CardOwn & { as: "div" } & Omit<
          HTMLAttributes<HTMLDivElement>,
          keyof CardOwn
        >),
) {
  const { as, variant, selected, className, ...rest } = props;
  const classes = cx("rz-card", variant && `rz-card--${variant}`, className);
  return as === "button" ? (
    <button
      type="button"
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      className={classes}
      aria-pressed={selected}
    />
  ) : (
    <div
      {...(rest as HTMLAttributes<HTMLDivElement>)}
      className={classes}
      data-selected={selected ? "" : undefined}
    />
  );
}

// ---- Chip -------------------------------------------------------------------------------------------------------
type ChipProps = {
  variant?: "dashed" | "quiet" | "toggle" | "mono";
  size?: "sm";
  onSide?: boolean; // sits on a --side / --row surface
  icon?: ReactNode;
  chevron?: boolean;
  pressed?: boolean; // variant="toggle"
  // A native <select> / <input type="date"> laid over the chip at opacity 0: the chip shows the value, the real
  // control keeps its label, keyboard behaviour and Playwright selectOption/fill. The root becomes a <label>.
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Test &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className">;
export const Chip = forwardRef<HTMLElement, ChipProps>(function Chip(
  {
    variant,
    size,
    onSide,
    icon,
    chevron,
    pressed,
    control,
    children,
    className,
    onClick,
    type = "button",
    ...rest
  },
  ref,
) {
  const classes = cx(
    "rz-chip",
    variant && `rz-chip--${variant}`,
    size && `rz-chip--${size}`,
    onSide && "rz-chip--onside",
    control !== undefined && "rz-chip--control",
    className,
  );
  const body = (
    <>
      {variant === "toggle" && <CheckIcon size={10} aria-hidden="true" />}
      {icon}
      {children !== undefined && <span>{children}</span>}
      {chevron && (
        <ChevronDown
          className="rz-chip__chevron"
          size={11}
          aria-hidden="true"
        />
      )}
    </>
  );
  if (control !== undefined)
    return (
      <label
        ref={ref as Ref<HTMLLabelElement>}
        className={classes}
        {...(rest as HTMLAttributes<HTMLLabelElement>)}
      >
        {body}
        <span className="rz-chip__control">{control}</span>
      </label>
    );
  if (onClick || variant === "toggle" || rest["aria-haspopup"])
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type={type}
        className={classes}
        aria-pressed={variant === "toggle" ? !!pressed : undefined}
        onClick={onClick}
        {...rest}
      >
        {body}
      </button>
    );
  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      className={cx(classes, "rz-chip--static")}
      {...(rest as HTMLAttributes<HTMLSpanElement>)}
    >
      {body}
    </span>
  );
});

// ---- Menu -------------------------------------------------------------------------------------------------------
export type MenuItem =
  | {
      type?: "item";
      id: string;
      label: ReactNode;
      icon?: ReactNode;
      hint?: ReactNode; // muted text on the right ("wacht op jou", a count)
      checked?: boolean; // shows a check column; role becomes menuitemradio / menuitemcheckbox
      multi?: boolean; // checkable item that keeps the menu open (Accounts: several companies)
      tone?: "warn";
      disabled?: boolean;
      title?: string;
      onSelect: () => void;
      "data-test"?: string;
    }
  | { type: "label"; id?: string; label: ReactNode }
  | { type: "separator"; id?: string };
export type MenuTriggerProps = {
  ref: Ref<any>;
  onClick: () => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls"?: string;
};
// A popover anchored to its trigger. Rendered in a portal with fixed positioning, so a scroll container, a modal
// or the sidebar can never clip it. Closes on outside press, Esc, Tab and after a choice; arrow keys move.
export function Menu({
  trigger,
  items,
  footer,
  label,
  align = "left",
  placement = "down",
  wide,
  className,
  onOpenChange,
  ...rest
}: {
  trigger: (props: MenuTriggerProps, open: boolean) => ReactNode;
  items: MenuItem[];
  footer?: { label: ReactNode; icon?: ReactNode; onSelect: () => void };
  label: string;
  align?: "left" | "right";
  placement?: "down" | "up";
  wide?: boolean;
  className?: string;
  onOpenChange?: (open: boolean) => void;
} & Test) {
  const [open, setOpenState] = useState(false),
    [place, setPlace] = useState<CSSProperties>({
      top: 0,
      left: 0,
      opacity: 0,
    }),
    anchor = useRef<HTMLElement>(null),
    panel = useRef<HTMLDivElement>(null),
    id = useId();
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) anchor.current?.focus({ preventScroll: true });
  };
  const entries = () =>
    Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) || [],
    );
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const a = anchor.current?.getBoundingClientRect(),
        p = panel.current;
      if (!a || !p) return;
      const gap = 6,
        edge = 8,
        up =
          placement === "up"
            ? a.top - gap - p.offsetHeight >= edge
            : a.bottom + gap + p.offsetHeight > window.innerHeight - edge &&
              a.top - gap - p.offsetHeight >= edge;
      const left = align === "right" ? a.right - p.offsetWidth : a.left;
      setPlace({
        top: Math.max(edge, up ? a.top - gap - p.offsetHeight : a.bottom + gap),
        left: Math.max(
          edge,
          Math.min(left, window.innerWidth - edge - p.offsetWidth),
        ),
      });
    };
    position();
    const items = entries();
    // A menu without a single choice (the bell's "Niets wacht op jou.") still has to take the focus, or Esc
    // and Tab never reach it.
    (
      items.find((e) => e.getAttribute("aria-checked") === "true") ||
      items[0] ||
      panel.current
    )?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target))
        return;
      close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, items.length]);
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = entries(),
      at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? all[(at + 1) % all.length]
        : event.key === "ArrowUp"
          ? all[(at - 1 + all.length) % all.length]
          : event.key === "Home"
            ? all[0]
            : event.key === "End"
              ? all[all.length - 1]
              : null;
    if (next) {
      event.preventDefault();
      next.focus({ preventScroll: true });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close(false);
  };
  const checkable = items.some(
    (i) =>
      i.type !== "label" && i.type !== "separator" && i.checked !== undefined,
  );
  return (
    <>
      {trigger(
        {
          ref: anchor,
          onClick: () => (open ? close(false) : setOpen(true)),
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? id : undefined,
        },
        open,
      )}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className={cx(
              "rz-menu rz-menu--float",
              wide && "rz-menu--wide",
              className,
            )}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            style={place}
            onKeyDown={keys}
            {...rest}
          >
            {items.map((item, index) =>
              item.type === "separator" ? (
                <div
                  key={item.id || index}
                  className="rz-menu__sep"
                  role="separator"
                />
              ) : item.type === "label" ? (
                <div
                  key={item.id || index}
                  className="rz-menu__label"
                  role="presentation"
                >
                  {item.label}
                </div>
              ) : (
                <button
                  key={item.id}
                  type="button"
                  className={cx(
                    "rz-menu__item",
                    item.tone && `rz-menu__item--${item.tone}`,
                  )}
                  role={
                    item.checked === undefined
                      ? "menuitem"
                      : item.multi
                        ? "menuitemcheckbox"
                        : "menuitemradio"
                  }
                  aria-checked={item.checked}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
                  title={item.title}
                  data-test={item["data-test"]}
                  onClick={() => {
                    if (item.disabled) return;
                    if (!item.multi) close();
                    item.onSelect();
                  }}
                >
                  {checkable && (
                    <span className="rz-menu__check" aria-hidden="true">
                      {item.checked && <CheckIcon size={12} />}
                    </span>
                  )}
                  {item.icon}
                  <span className="rz-menu__text">{item.label}</span>
                  {item.hint !== undefined && (
                    <span className="rz-menu__hint">{item.hint}</span>
                  )}
                </button>
              ),
            )}
            {footer && (
              <>
                <div className="rz-menu__sep" role="separator" />
                <button
                  type="button"
                  className="rz-menu__item rz-menu__item--foot"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    close();
                    footer.onSelect();
                  }}
                >
                  {checkable && <span className="rz-menu__check" />}
                  {footer.icon}
                  <span className="rz-menu__text">{footer.label}</span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---- Toast ------------------------------------------------------------------------------------------------------
export function Toast({
  tone = "notice",
  wrap,
  inCanvas,
  onClose,
  className,
  children,
  ...rest
}: {
  tone?: "notice" | "error"; // error = role alert, notice = role status
  wrap?: boolean; // long messages
  inCanvas?: boolean; // centred in the canvas instead of the content column
  onClose?: () => void;
} & Test &
  HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "rz-toast",
        wrap && "rz-toast--wrap",
        inCanvas && "rz-toast--in-canvas",
        className,
      )}
      role={tone === "error" ? "alert" : "status"}
      {...rest}
    >
      <span>{children}</span>
      {onClose && (
        <IconButton
          size="xs"
          label={
            tone === "error" ? tr("Foutmelding sluiten") : tr("Melding sluiten")
          }
          onClick={onClose}
        >
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}

// ---- Check ------------------------------------------------------------------------------------------------------
type CheckOwn = {
  checked: boolean;
  label: string; // accessible name
  shape?: "circle" | "square"; // circle 20 (Vandaag), square 18 r6 (Beoordelen)
  size?: "sm" | "xs"; // sm = 18px circle (Project list); xs = 15px square (wizard criteria)
  dashed?: boolean;
  className?: string;
} & Test;
type CheckInput = CheckOwn & {
  as?: "input";
  onChange: (checked: boolean) => void;
  disabled?: boolean;
} & Omit<HTMLAttributes<HTMLLabelElement>, keyof CheckOwn | "onChange">;
type CheckButton = CheckOwn & { as: "button" } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    keyof CheckOwn
  >;
// Default: a real <input type="checkbox"> under the drawn box (checkbox semantics, Space toggles, forms work).
// as="button": an action whose name changes with the state ("Rond af: …" / "Heropen: …"), used by TaskCheck.
export function Check(props: CheckInput | CheckButton) {
  const { as, checked, label, shape, size, dashed, className, ...rest } = props;
  const classes = cx(
    "rz-check",
    shape === "square" && size !== "xs" && "rz-check--square",
    size && `rz-check--${size}`,
    dashed && "rz-check--dashed",
    className,
  );
  const box = (
    <span className="rz-check__box" aria-hidden="true">
      <CheckIcon />
    </span>
  );
  if (as === "button")
    return (
      <button
        type="button"
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
        className={classes}
        aria-label={label}
        data-checked={checked ? "" : undefined}
      >
        {box}
      </button>
    );
  const { onChange, disabled, ...labelRest } = rest as Omit<
    CheckInput,
    keyof CheckOwn | "as"
  >;
  return (
    <label className={classes} {...labelRest}>
      <input
        type="checkbox"
        className="rz-check__input"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {box}
    </label>
  );
}

// ---- Fields -----------------------------------------------------------------------------------------------------
export function Field({
  label,
  hint,
  error,
  as: Tag = "label",
  className,
  children,
  ...rest
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  as?: "label" | "div"; // div when the field holds more than one control
} & Test &
  HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cx("rz-field", className)} {...rest}>
      <span className="rz-field__label">{label}</span>
      {children}
      {hint && <span className="rz-hint">{hint}</span>}
      {error && (
        <span className="rz-error" role="alert">
          {error}
        </span>
      )}
    </Tag>
  );
}
export const Input = forwardRef<
  HTMLInputElement,
  { bare?: boolean; titleSize?: boolean } & Test &
    InputHTMLAttributes<HTMLInputElement>
>(function Input({ bare, titleSize, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        "rz-input",
        (bare || titleSize) && "rz-input--bare",
        titleSize && "rz-input--title",
        className,
      )}
      {...rest}
    />
  );
});
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  { small?: boolean } & Test & TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ small, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx("rz-textarea", small && "rz-textarea--sm", className)}
      {...rest}
    />
  );
});
export const Select = forwardRef<
  HTMLSelectElement,
  Test & SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx("rz-select", className)} {...rest} />;
});

// ---- Empty ------------------------------------------------------------------------------------------------------
export function Empty({
  title,
  children,
  action,
  icon,
  inline,
  className,
  ...rest
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  inline?: boolean; // an empty list inside a section: a quiet line instead of the centred block
} & Test &
  Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div
      className={cx("rz-empty", inline && "rz-empty--inline", className)}
      {...rest}
    >
      {icon && (
        <div className="rz-empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h2 className="rz-empty__title">{title}</h2>
      {children && <p className="rz-empty__text">{children}</p>}
      {action}
    </div>
  );
}

// ---- Modal ------------------------------------------------------------------------------------------------------
// Moved from Editor.tsx (which re-exports it). The focus trap, Escape and focus restore are verbatim.
export function Modal({
  title,
  children,
  close,
  wide = false,
  width,
  scroll = "overlay",
  className = "",
  subtitle,
  header,
  "data-test": test = "modal",
}: {
  title: string; // always the accessible name of the dialog, also when `header` replaces the visible title
  children: ReactNode;
  close: () => void;
  wide?: boolean; // = width "wide"; kept for the existing call sites
  width?: "sm" | "notes" | "wide" | "file" | number; // 480 / 640 / 760 / 880+80vh / px. Default 600
  scroll?: "overlay" | "body"; // body: long forms keep head and footer in view
  className?: string;
  subtitle?: ReactNode;
  header?: ReactNode; // replaces the title block, shares the row with the close button (wizard steps)
} & Test) {
  const panel = useRef<HTMLElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current!;
    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length);
    (
      node.querySelector<HTMLElement>(
        "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
      ) || focusable()[0]
    )?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const all = focusable(),
          first = all[0],
          last = all[all.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    node.addEventListener("keydown", keys);
    return () => {
      node.removeEventListener("keydown", keys);
      previous?.focus();
    };
  }, []);
  const size = width ?? (wide ? "wide" : undefined);
  return (
    <div
      className="rz-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={cx(
          "rz-modal",
          typeof size === "string" && `rz-modal--${size}`,
          scroll === "body" && "rz-modal--scroll-body",
          className,
        )}
        style={
          typeof size === "number"
            ? vars({ "--rz-modal-w": `${size}px` })
            : undefined
        }
        data-test={test}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="rz-modal__head">
          {header ?? (
            <div className="rz-modal__titles">
              {subtitle && <div className="rz-modal__subtitle">{subtitle}</div>}
              <h2 className="rz-modal__title">{title}</h2>
            </div>
          )}
          <IconButton size="sm" label={tr("Sluiten")} onClick={close}>
            <X size={14} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}
// Building blocks for migrated modal content. Un-migrated content (.form-body, .modal-footer) keeps working as is.
export function ModalBody({
  className,
  children,
  ...rest
}: Test & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rz-modal__body", className)} {...rest}>
      {children}
    </div>
  );
}
export function ModalFoot({
  docked,
  left,
  className,
  children,
  ...rest
}: {
  docked?: boolean; // outside the scrolling body (scroll="body"); otherwise it is the last child of ModalBody
  left?: ReactNode; // "Noorderlicht Studio · werkmap gekoppeld", "← Terug"
} & Test &
  HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "rz-modal__foot",
        docked && "rz-modal__foot--docked",
        className,
      )}
      {...rest}
    >
      <span className="rz-hint">{left}</span>
      <div className="rz-modal__foot-actions">{children}</div>
    </div>
  );
}
export function Steps({
  steps,
  current,
  onStep,
  className,
  ...rest
}: {
  steps: { label: ReactNode; disabled?: boolean }[];
  current: number; // 0-based
  onStep?: (index: number) => void;
} & Test &
  HTMLAttributes<HTMLElement>) {
  return (
    <nav className={cx("rz-steps", className)} {...rest}>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="rz-steps__sep" aria-hidden="true" />}
          <button
            type="button"
            className="rz-steps__step"
            aria-current={index === current ? "step" : undefined}
            disabled={step.disabled}
            onClick={() => onStep?.(index)}
          >
            {step.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
