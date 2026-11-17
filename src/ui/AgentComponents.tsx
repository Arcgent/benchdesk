import { useState } from "react";
import { t as tr, locale } from "../shared/i18n";
import type { ComponentSpec, ComponentValues } from "../shared/components";
import { Button } from "./rz";

// Renders one show_component chat item. Specs are validated by componentSpec
// before they reach this file; values are validated again by the runner.
type Props = {
  spec: ComponentSpec;
  status: "pending" | "complete" | string;
  values?: ComponentValues;
  submit?: (values: ComponentValues) => Promise<unknown> | void;
};
const palette = ["var(--accent)", "var(--blue)", "var(--warn)", "var(--tint-codex)"];

export function AgentComponent({ spec, status, values, submit }: Props) {
  const done = status !== "pending";
  switch (spec.type) {
    case "card":
      return (
        <div className="agc agc-card">
          <h4>{spec.title}</h4>
          {spec.body && <p>{spec.body}</p>}
          {!!spec.fields.length && (
            <dl>
              {spec.fields.map((f, i) => (
                <div key={i}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {!!spec.links.length && (
            <div className="agc-links">
              {spec.links.map((l, i) => (
                <a key={i} href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      );
    case "table":
      return (
        <div className="agc agc-table">
          {spec.title && <h4>{spec.title}</h4>}
          <div className="agc-scroll">
            <table>
              <thead>
                <tr>
                  {spec.columns.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spec.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={typeof v === "number" ? "num" : ""}>
                        {typeof v === "number" ? v.toLocaleString(locale()) : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "chart":
      return <Chart spec={spec} />;
    case "choice":
      return <Choice spec={spec} done={done} values={values} submit={submit} />;
    case "checklist":
      return <Checklist spec={spec} done={done} values={values} submit={submit} />;
    case "form":
      return <Form spec={spec} done={done} values={values} submit={submit} />;
  }
}

function Chart({ spec }: { spec: Extract<ComponentSpec, { type: "chart" }> }) {
  const labels = [...new Set(spec.series.flatMap((s) => s.points.map((p) => p.label)))];
  const all = spec.series.flatMap((s) => s.points.map((p) => p.value));
  const max = Math.max(0, ...all), min = Math.min(0, ...all);
  const W = 560, H = 200, L = 40, B = 24, T = 10, span = max - min || 1;
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / span);
  const band = (W - L) / labels.length;
  const fmt = (v: number) => `${v.toLocaleString(locale(), { maximumFractionDigits: 1 })}${spec.unit}`;
  const ticks = [min, min + span / 2, max];
  return (
    <figure className="agc agc-chart">
      {spec.title && <h4>{spec.title}</h4>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title || tr("Grafiek")}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} className="agc-grid" />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" className="agc-axis">{fmt(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text key={l} x={L + band * (i + 0.5)} y={H - 6} textAnchor="middle" className="agc-axis">{l}</text>
        ))}
        {spec.kind === "bar"
          ? spec.series.map((s, si) => {
              const w = (band * 0.7) / spec.series.length;
              return s.points.map((p) => {
                const i = labels.indexOf(p.label);
                const x = L + band * i + band * 0.15 + w * si;
                return (
                  <rect key={`${si}-${p.label}`} x={x} width={Math.max(1, w - 2)} y={Math.min(y(p.value), y(0))} height={Math.abs(y(p.value) - y(0))} rx={3} fill={palette[si]}>
                    <title>{`${s.name} · ${p.label}: ${fmt(p.value)}`}</title>
                  </rect>
                );
              });
            })
          : spec.series.map((s, si) => (
              <g key={si}>
                <polyline fill="none" stroke={palette[si]} strokeWidth={2} strokeLinejoin="round" points={s.points.map((p) => `${L + band * (labels.indexOf(p.label) + 0.5)},${y(p.value)}`).join(" ")} />
                {s.points.map((p) => (
                  <circle key={p.label} cx={L + band * (labels.indexOf(p.label) + 0.5)} cy={y(p.value)} r={3} fill={palette[si]}>
                    <title>{`${s.name} · ${p.label}: ${fmt(p.value)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
      </svg>
      {spec.series.length > 1 && (
        <figcaption className="agc-legend">
          {spec.series.map((s, i) => (
            <span key={i}><i style={{ background: palette[i] }} />{s.name}</span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

type Interactive<T extends ComponentSpec["type"]> = {
  spec: Extract<ComponentSpec, { type: T }>;
  done: boolean;
  values?: ComponentValues;
  submit?: Props["submit"];
};
function useSubmit(submit?: Props["submit"]) {
  const [busy, setBusy] = useState(false);
  return [busy, (values: ComponentValues) => {
    setBusy(true);
    Promise.resolve(submit?.(values)).finally(() => setBusy(false));
  }] as const;
}

function Choice({ spec, done, values, submit }: Interactive<"choice">) {
  const [picked, setPicked] = useState<string[]>((values?.selected as string[]) || []);
  const [busy, send] = useSubmit(submit);
  const toggle = (id: string) =>
    setPicked(spec.multiple ? (picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) : [id]);
  return (
    <div className={`agc agc-choice${done ? " is-done" : ""}`}>
      <h4>{spec.title}</h4>
      <div className="agc-options" role={spec.multiple ? "group" : "radiogroup"}>
        {spec.options.map((o) => (
          <button key={o.id} type="button" role={spec.multiple ? "checkbox" : "radio"} aria-checked={picked.includes(o.id)} disabled={done || busy} onClick={() => toggle(o.id)}>
            <b>{o.label}</b>
            {o.description && <span>{o.description}</span>}
          </button>
        ))}
      </div>
      {done ? (
        <p className="agc-done">✓ {tr("Verstuurd")}</p>
      ) : (
        <div className="agc-foot">
          <Button variant="primary" disabled={busy || !picked.length} onClick={() => send({ selected: picked })}>
            {spec.multiple && picked.length ? tr("Kies {0}", picked.length) : tr("Kiezen")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Checklist({ spec, done, values, submit }: Interactive<"checklist">) {
  const [checked, setChecked] = useState<string[]>(
    (values?.selected as string[]) || spec.items.filter((i) => i.checked).map((i) => i.id),
  );
  const [busy, send] = useSubmit(submit);
  return (
    <div className={`agc agc-checklist${done ? " is-done" : ""}`}>
      <h4>{spec.title} <span>{checked.length}/{spec.items.length}</span></h4>
      <ul>
        {spec.items.map((i) => (
          <li key={i.id}>
            <label>
              <input type="checkbox" checked={checked.includes(i.id)} disabled={done || busy}
                onChange={() => setChecked(checked.includes(i.id) ? checked.filter((x) => x !== i.id) : [...checked, i.id])} />
              {i.label}
            </label>
          </li>
        ))}
      </ul>
      {done ? <p className="agc-done">✓ {tr("Verstuurd")}</p> : (
        <div className="agc-foot"><Button variant="primary" disabled={busy} onClick={() => send({ selected: checked })}>{tr("Bijwerken")}</Button></div>
      )}
    </div>
  );
}

function Form({ spec, done, values, submit }: Interactive<"form">) {
  const [data, setData] = useState<Record<string, string | boolean>>(
    Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)])),
  );
  const [busy, send] = useSubmit(submit);
  const missing = spec.fields.some((f) => f.required && (f.kind === "checkbox" ? data[f.id] !== true : !String(data[f.id] ?? "").trim()));
  return (
    <form className={`agc agc-form${done ? " is-done" : ""}`} onSubmit={(e) => { e.preventDefault(); send(data as ComponentValues); }}>
      <h4>{spec.title}</h4>
      <fieldset disabled={done || busy}>
        {spec.fields.map((f) => {
          const set = (v: string | boolean) => setData({ ...data, [f.id]: v });
          const value = data[f.id];
          return f.kind === "checkbox" ? (
            <label key={f.id} className="agc-check">
              <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} />
              {f.label}{f.required && <em> *</em>}
            </label>
          ) : (
            <label key={f.id} className="agc-field">
              <span>{f.label}{f.required && <em> *</em>}</span>
              {f.kind === "textarea" ? (
                <textarea rows={3} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />
              ) : f.kind === "select" ? (
                <select value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
                  <option value="">{tr("Kies…")}</option>
                  {f.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />
              )}
            </label>
          );
        })}
      </fieldset>
      {done ? <p className="agc-done">✓ {tr("Verstuurd")}</p> : (
        <div className="agc-foot"><Button variant="primary" type="submit" disabled={busy || missing}>{spec.submitLabel || tr("Versturen")}</Button></div>
      )}
    </form>
  );
}
