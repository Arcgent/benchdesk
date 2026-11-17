import test from "node:test";
import assert from "node:assert/strict";
import {
  componentFallbackText,
  componentSpec,
  interactive,
  submissionText,
  validateSubmission,
} from "../src/shared/components";

test("component catalog enforces caps, https links and consistent tables", () => {
  assert.ok(componentSpec.safeParse({ type: "card", title: "Offerte", links: [{ label: "Site", url: "https://example.com" }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "card", title: "X", links: [{ label: "x", url: "http://a.nl" }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "card", title: "X", links: [{ label: "x", url: "javascript:alert(1)" }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "table", columns: ["a", "b"], rows: [["1"]] }).success);
  assert.ok(!componentSpec.safeParse({ type: "table", columns: ["a"], rows: Array(51).fill(["x"]) }).success);
  assert.ok(!componentSpec.safeParse({ type: "choice", title: "Kies", options: [{ id: "a", label: "A" }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "form", title: "F", fields: [{ id: "a", label: "A", kind: "select" }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "form", title: "F", fields: [{ id: "a", label: "A", kind: "text" }, { id: "a", label: "B", kind: "text" }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "chart", kind: "pie", series: [{ name: "a", points: [{ label: "x", value: 1 }] }] }).success);
  assert.ok(!componentSpec.safeParse({ type: "html", html: "<b>x</b>" }).success);
});

test("form submissions are validated and normalized", () => {
  const spec = componentSpec.parse({
    type: "form",
    title: "Intake",
    fields: [
      { id: "name", label: "Naam", kind: "text", required: true },
      { id: "budget", label: "Budget", kind: "number" },
      { id: "plan", label: "Pakket", kind: "select", options: ["Basis", "Pro"] },
      { id: "start", label: "Start", kind: "date" },
      { id: "ok", label: "Akkoord", kind: "checkbox", required: true },
    ],
  });
  assert.ok(interactive(spec));
  assert.throws(() => validateSubmission(spec, { ok: true }), /Naam is verplicht/);
  assert.throws(() => validateSubmission(spec, { name: "A", ok: true, budget: "veel" }), /getal/);
  assert.throws(() => validateSubmission(spec, { name: "A", ok: true, plan: "Gratis" }), /opties/);
  assert.throws(() => validateSubmission(spec, { name: "A", ok: true, start: "morgen" }), /datum/);
  assert.throws(() => validateSubmission(spec, { name: "A", ok: false }), /Akkoord is verplicht/);
  const values = validateSubmission(spec, { name: " Sam ", budget: "1500", plan: "Pro", ok: true });
  assert.deepEqual(values, { name: "Sam", budget: 1500, plan: "Pro", ok: true });
  assert.match(submissionText(spec, values), /Budget \(budget\): 1500/);
});

test("choice and checklist accept only known ids; display components take no input", () => {
  const choice = componentSpec.parse({ type: "choice", title: "Richting", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  assert.throws(() => validateSubmission(choice, { selected: [] }), /keuze/);
  assert.throws(() => validateSubmission(choice, { selected: ["a", "b"] }), /één/);
  assert.throws(() => validateSubmission(choice, { selected: ["z"] }), /Ongeldige/);
  assert.equal(submissionText(choice, validateSubmission(choice, { selected: ["b"] })), 'Keuze bij "Richting": B (b)');
  const list = componentSpec.parse({ type: "checklist", title: "Check", items: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] });
  assert.deepEqual(validateSubmission(list, { selected: [] }), { selected: [] });
  const card = componentSpec.parse({ type: "card", title: "Kaart" });
  assert.ok(!interactive(card));
  assert.throws(() => validateSubmission(card, {}), /geen invoer/);
});

test("fallback text keeps content readable without the renderer", () => {
  const table = componentSpec.parse({ type: "table", title: "Leads", columns: ["Naam", "Waarde"], rows: [["A|B", 3]] });
  assert.equal(componentFallbackText(table), "**Leads**\n| Naam | Waarde |\n| --- | --- |\n| A\\|B | 3 |");
  const chart = componentSpec.parse({ type: "chart", kind: "bar", unit: "%", series: [{ name: "Conversie", points: [{ label: "jan", value: 2 }] }] });
  assert.equal(componentFallbackText(chart), "Conversie: jan 2%");
});
