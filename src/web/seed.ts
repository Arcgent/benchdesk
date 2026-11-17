import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store";

export function seedPreview(dataDir: string) {
  const store = new Store(join(dataDir, "werk.sqlite"));
  try {
    if (store.snapshot().companies.length) return;
    const workspace = join(dataDir, "voorbeeld-werkmap");
    mkdirSync(workspace, { recursive: true });
    const companyId = store.saveCompany({
      name: "Noorderlicht Studio",
      workspacePath: workspace,
      product:
        "Wij helpen dienstverleners hun merk en aanbod helder neer te zetten.",
      audience:
        "Zakelijke dienstverleners met 5–25 medewerkers die willen doorgroeien.",
      stage: "eerste klanten",
      bottleneck: "Een voorspelbare stroom nieuwe gesprekken.",
    });
    const dueDate = new Date(Date.now() + 14 * 86400000)
      .toISOString()
      .slice(0, 10);
    const goalId = store.saveGoal({
      companyId,
      title: "12 klantgesprekken per maand",
      current: 5,
      target: 12,
      unit: "gesprekken",
      dueDate,
      primary: true,
    });
    const projectId = store.saveProject({
      companyId,
      name: "Cold email",
      description:
        "Een herhaalbare acquisitieroute die maandelijks passende klantgesprekken oplevert.",
      goalId,
      dueDate,
    });
    const proposalProject = store.saveProject({
      companyId,
      name: "Klantvoorstellen",
      description: "Van een goed gesprek naar een helder voorstel.",
      goalId,
    });
    const onboarding = store.saveProject({
      companyId,
      name: "Onboarding",
      description: "Een zorgvuldige start voor iedere nieuwe klant.",
    });
    store.saveTask({
      companyId,
      projectId,
      goalId,
      title: "Doelgroep en aanbod aanscherpen",
      kind: "human",
      status: "done",
    });
    store.saveTask({
      companyId,
      projectId,
      goalId,
      title: "E-maildomein en verzendinstellingen controleren",
      status: "done",
    });
    const file = join(workspace, "campagne-opzet.md");
    writeFileSync(
      file,
      "# Campagne-opzet cold email\n\nVoorbeeldgegevens voor het ontwerp van Benchdesk.\n\n## Drie varianten\nVariant A: een concreet proces verbeteren.\nVariant B: een herkenbaar knelpunt.\nVariant C: ruimte voor de volgende groeistap.\n\n## Verzendschema\nHet verzendmoment moet nog worden onderbouwd.\n",
    );
    const criteria = [
      "Drie e-mailvarianten, passend bij het aanbod",
      "Duidelijke doelgroep en persoonlijke opening",
      "Verzendmomenten onderbouwd",
    ].map((text, i) => ({
      id: randomUUID(),
      text,
      checked: i < 2,
      agentNote: [
        "Drie varianten geschreven en gecontroleerd.",
        "De opening sluit aan op de geselecteerde doelgroep.",
        "De timing is genoemd, maar nog niet onderbouwd.",
      ][i],
      evidence: { path: file, line: [5, 7, 11][i] },
    }));
    const review = store.saveTask({
      companyId,
      projectId,
      goalId,
      title: "Campagne-opzet cold email beoordelen",
      provider: "codex",
      status: "review",
      description:
        "Beoordeel de drie korte e-mailvarianten en de onderbouwing van het verzendschema.",
      criteria,
    });
    store.addArtifact(review, file);
    store.saveTask({
      companyId,
      projectId,
      goalId,
      title: "ICP-lijst van 40 bedrijven",
      provider: "claude",
      status: "in_progress",
      dueDate,
    });
    const human = store.saveTask({
      companyId,
      projectId: proposalProject,
      goalId,
      title: "Voorstelsjabloon herschrijven",
      kind: "human",
    });
    store.saveTask({
      companyId,
      projectId: onboarding,
      title: "Onboarding-checklist v2",
      dependencies: [human],
      status: "blocked",
    });
    store.saveTask({
      companyId,
      projectId,
      goalId,
      title: "Eerste 40 mails versturen",
      dependencies: [review],
      status: "blocked",
      dueDate,
    });
    store.checkin(
      companyId,
      "Vijf gesprekken gevoerd. Eerst de campagne beoordelen, dan kan de volgende stap door.",
      [{ goalId, current: 5 }],
    );
    store.saveCompany({
      name: "Bakkerij Vermeer",
      workspacePath: workspace,
      stage: "gevestigd bedrijf",
    });
    writeFileSync(
      join(dataDir, "preview-info.txt"),
      "Voorbeeldgegevens voor de localhost-versie van Benchdesk. Deze database staat los van de desktop-app.\n",
    );
  } finally {
    store.close();
  }
}
