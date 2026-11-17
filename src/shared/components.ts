import { z } from "zod";

// A fixed catalog of chat components an agent may show instead of plain text.
// Shape borrows from A2UI (ids, data, actions) but stays static and small: no
// HTML, no remote images, links only over https. Every spec also renders to a
// plain-text fallback so search, mobile and history keep working.
const text = (max: number) => z.string().trim().max(max);
const label = z.string().trim().min(1).max(200);
const id = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,60}$/, "Gebruik letters, cijfers, - of _.");
const httpsUrl = z
  .string()
  .max(2000)
  .url()
  .refine((u) => u.startsWith("https://"), "Alleen https-links.");
const unique = <T>(items: T[], key: (t: T) => string) =>
  new Set(items.map(key)).size === items.length;

const card = z.object({
  type: z.literal("card"),
  title: label,
  body: text(4000).default(""),
  fields: z
    .array(z.object({ label, value: text(500) }))
    .max(12)
    .default([]),
  links: z
    .array(z.object({ label, url: httpsUrl }))
    .max(5)
    .default([]),
});
const table = z
  .object({
    type: z.literal("table"),
    title: text(200).default(""),
    columns: z.array(label).min(1).max(10),
    rows: z
      .array(z.array(z.union([text(500), z.number().finite()])))
      .max(50),
  })
  .refine((t) => t.rows.every((r) => r.length === t.columns.length), {
    message: "Elke rij heeft evenveel cellen als er kolommen zijn.",
  });
const chart = z
  .object({
    type: z.literal("chart"),
    title: text(200).default(""),
    kind: z.enum(["bar", "line"]),
    unit: text(20).default(""),
    series: z
      .array(
        z.object({
          name: label,
          points: z
            .array(z.object({ label: text(60), value: z.number().finite() }))
            .min(1)
            .max(50),
        }),
      )
      .min(1)
      .max(4),
  })
  .refine((c) => c.series.reduce((n, s) => n + s.points.length, 0) <= 200, {
    message: "Maximaal 200 punten per grafiek.",
  });
const formField = z.object({
  id,
  label,
  kind: z.enum(["text", "textarea", "number", "select", "checkbox", "date"]),
  required: z.boolean().default(false),
  options: z.array(label).max(20).default([]),
  placeholder: text(200).default(""),
});
const form = z
  .object({
    type: z.literal("form"),
    title: label,
    submitLabel: text(40).default(""),
    fields: z.array(formField).min(1).max(20),
  })
  .refine((f) => unique(f.fields, (x) => x.id), {
    message: "Veld-id's moeten uniek zijn.",
  })
  .refine(
    (f) => f.fields.every((x) => x.kind !== "select" || x.options.length > 0),
    { message: "Een keuzelijst heeft opties nodig." },
  );
const choice = z
  .object({
    type: z.literal("choice"),
    title: label,
    multiple: z.boolean().default(false),
    options: z
      .array(z.object({ id, label, description: text(300).default("") }))
      .min(2)
      .max(8),
  })
  .refine((c) => unique(c.options, (x) => x.id), {
    message: "Optie-id's moeten uniek zijn.",
  });
const checklist = z
  .object({
    type: z.literal("checklist"),
    title: label,
    items: z
      .array(z.object({ id, label, checked: z.boolean().default(false) }))
      .min(1)
      .max(30),
  })
  .refine((c) => unique(c.items, (x) => x.id), {
    message: "Item-id's moeten uniek zijn.",
  });

// z.discriminatedUnion does not accept refined objects; the type field keeps
// errors specific enough.
export const componentSpec = z.union([card, table, chart, form, choice, checklist]);
export type ComponentSpec = z.infer<typeof componentSpec>;
export type ComponentValues = Record<string, string | number | boolean | string[]>;
export const interactive = (spec: ComponentSpec) =>
  spec.type === "form" || spec.type === "choice" || spec.type === "checklist";

export function validateSubmission(
  spec: ComponentSpec,
  input: unknown,
): ComponentValues {
  const values = z.record(z.unknown()).parse(input ?? {});
  if (spec.type === "form") {
    const out: ComponentValues = {};
    for (const f of spec.fields) {
      const raw = values[f.id];
      if (f.kind === "checkbox") {
        if (raw !== undefined && typeof raw !== "boolean")
          throw new Error(`${f.label}: kies ja of nee.`);
        if (f.required && raw !== true) throw new Error(`${f.label} is verplicht.`);
        out[f.id] = raw === true;
        continue;
      }
      const value = raw === undefined || raw === null ? "" : String(raw).trim();
      if (!value) {
        if (f.required) throw new Error(`${f.label} is verplicht.`);
        continue;
      }
      if (value.length > 4000) throw new Error(`${f.label} is te lang.`);
      if (f.kind === "number") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`${f.label}: vul een getal in.`);
        out[f.id] = n;
      } else if (f.kind === "select") {
        if (!f.options.includes(value))
          throw new Error(`${f.label}: kies een van de opties.`);
        out[f.id] = value;
      } else if (f.kind === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
          throw new Error(`${f.label}: kies een geldige datum.`);
        out[f.id] = value;
      } else out[f.id] = value;
    }
    return out;
  }
  if (spec.type === "choice" || spec.type === "checklist") {
    const ids = new Set(
      (spec.type === "choice" ? spec.options : spec.items).map((x) => x.id),
    );
    const selected = z
      .array(z.string())
      .max(30)
      .parse(values.selected ?? []);
    if (new Set(selected).size !== selected.length || selected.some((s) => !ids.has(s)))
      throw new Error("Ongeldige keuze.");
    if (spec.type === "choice") {
      if (!selected.length) throw new Error("Maak eerst een keuze.");
      if (!spec.multiple && selected.length > 1)
        throw new Error("Kies één optie.");
    }
    return { selected };
  }
  throw new Error("Dit onderdeel vraagt geen invoer.");
}

const cell = (v: string | number) => String(v).replace(/\|/g, "\\|");
export function componentFallbackText(spec: ComponentSpec): string {
  switch (spec.type) {
    case "card":
      return [
        `**${spec.title}**`,
        spec.body,
        ...spec.fields.map((f) => `- ${f.label}: ${f.value}`),
        ...spec.links.map((l) => `- [${l.label}](${l.url})`),
      ]
        .filter(Boolean)
        .join("\n");
    case "table":
      return [
        spec.title && `**${spec.title}**`,
        `| ${spec.columns.map(cell).join(" | ")} |`,
        `| ${spec.columns.map(() => "---").join(" | ")} |`,
        ...spec.rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
      ]
        .filter(Boolean)
        .join("\n");
    case "chart":
      return [
        spec.title && `**${spec.title}**`,
        ...spec.series.map(
          (s) =>
            `${s.name}: ${s.points.map((p) => `${p.label} ${p.value}${spec.unit}`).join(", ")}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
    case "form":
      return [`**${spec.title}**`, ...spec.fields.map((f) => `- ${f.label}`)].join("\n");
    case "choice":
      return [`**${spec.title}**`, ...spec.options.map((o) => `- ${o.label}`)].join("\n");
    case "checklist":
      return [
        `**${spec.title}**`,
        ...spec.items.map((i) => `- [${i.checked ? "x" : " "}] ${i.label}`),
      ].join("\n");
  }
}

// What the agent reads back as the next user message.
export function submissionText(spec: ComponentSpec, values: ComponentValues) {
  if (spec.type === "form")
    return `Formulier "${spec.title}" ingevuld:\n${spec.fields
      .map((f) => `- ${f.label} (${f.id}): ${values[f.id] === undefined ? "—" : String(values[f.id])}`)
      .join("\n")}`;
  const selected = new Set(values.selected as string[]);
  if (spec.type === "choice")
    return `Keuze bij "${spec.title}": ${spec.options
      .filter((o) => selected.has(o.id))
      .map((o) => `${o.label} (${o.id})`)
      .join(", ")}`;
  if (spec.type === "checklist")
    return `Checklist "${spec.title}" bijgewerkt:\n${spec.items
      .map((i) => `- [${selected.has(i.id) ? "x" : " "}] ${i.label} (${i.id})`)
      .join("\n")}`;
  return "";
}
