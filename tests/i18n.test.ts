import test from "node:test";
import assert from "node:assert/strict";
import english from "../src/shared/locales/en.json";
import { locale, setLanguage, t, translateMessage } from "../src/shared/i18n";

test("English interface messages preserve interpolation values and Dutch fallback", () => {
  setLanguage("en");
  assert.equal(t("Vandaag"), "Today");
  assert.equal(locale(), "en-GB");
  assert.equal(
    t("{0} bewerken", "Vandaag {1} <script>"),
    "Edit Vandaag {1} <script>",
  );
  assert.equal(
    t("Mijn eigen taak blijft Nederlands"),
    "Mijn eigen taak blijft Nederlands",
  );
  assert.equal(
    translateMessage("Wekelijks · volgende 21-09-2026"),
    "Weekly · next 21-09-2026",
  );
  assert.equal(
    translateMessage(
      "Deze taak staat gepland voor 2026-09-21. Pas de plandatum aan om eerder te starten.",
    ),
    "This task is scheduled for 2026-09-21. Change the scheduled date to start earlier.",
  );
  setLanguage("nl");
  assert.equal(t("Vandaag"), "Vandaag");
  assert.equal(locale(), "nl-NL");
  assert.equal(t("{0} bewerken", "Sales"), "Sales bewerken");
});

test("every English message retains all interpolation slots", () => {
  const slots = (text: string) =>
    [...new Set(text.match(/\{\d+\}/g) || [])].sort();
  for (const [source, translation] of Object.entries(english)) {
    assert.ok(translation.trim(), source);
    assert.deepEqual(slots(translation), slots(source), source);
  }
});
