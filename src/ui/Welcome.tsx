import { t as tr } from "../shared/i18n";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Inventory } from "../shared/types";
import { api, type AppInfo, type Workbench } from "./model";
import { providerName, shortPath } from "./primitives";
import { Button, Field, Input, StatusDot, Textarea } from "./rz";
import { Brand } from "./Theme";

export function Welcome({
  info,
  inventory,
  run,
  created,
}: {
  info: AppInfo;
  inventory: Inventory | null;
  run: Workbench["run"];
  created: (id: string, intake: boolean) => void;
}) {
  const [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const folder = path || info.defaultWorkspace;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const intake =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("data-intake") ===
      "true";
    setBusy(true);
    void run(async () => {
      const id = await api<string>("company.save", {
        value: {
          name,
          workspacePath: folder,
          product: description,
          color: "#4fd98a",
        },
      });
      created(id, intake);
    }).finally(() => setBusy(false));
  };
  // Enter in a field means "Bedrijf aanmaken". Left to the browser it would press the first submit button
  // in the form, which is the intake one.
  const enter = (e: KeyboardEvent<HTMLFormElement>) => {
    if (
      e.key !== "Enter" ||
      e.nativeEvent.isComposing ||
      !(e.target instanceof HTMLInputElement)
    )
      return;
    e.preventDefault();
    if (!busy) e.currentTarget.requestSubmit(primary.current);
  };
  return (
    <div className="rz-appstate" data-test="welcome">
      <div className="rz-appstate__col">
        <Brand />
        <header className="rz-appstate__head">
          <h1 className="rz-h1">
            {tr("Begin met het bedrijf waar je aan werkt.")}
          </h1>
          <p className="rz-lead">
            {tr(
              "Je doelen, projecten en assistenten op één plek. Koppel je werkmap en kies je eerste stap.",
            )}
          </p>
        </header>
        <ul className="rz-onboarding__checks" aria-label={tr("Assistenten")}>
          {["claude", "codex"].map((provider) => {
            const cli = inventory?.providers.find((p) => p.name === provider),
              assistant = providerName(provider);
            return (
              <li className="rz-onboarding__check" key={provider}>
                {cli?.path ? (
                  <StatusDot
                    tone="accent"
                    label={tr("{0} gevonden", assistant)}
                  />
                ) : inventory ? (
                  <StatusDot
                    tone="warn"
                    label={
                      <span>
                        {tr("{0} niet gevonden", assistant)}
                        <span className="rz-onboarding__later">
                          {" · "}
                          {tr("later instellen")}
                        </span>
                      </span>
                    }
                  />
                ) : (
                  <StatusDot
                    tone="muted"
                    label={tr("{0} wordt gecontroleerd…", assistant)}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="rz-onboarding__form"
          aria-label={tr("Je eerste bedrijf")}
          onSubmit={submit}
          onKeyDown={enter}
        >
          <Field label={tr("Bedrijfsnaam")}>
            <Input
              autoFocus
              required
              placeholder={tr("Hoe heet je bedrijf?")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            as="div"
            label={tr("Werkmap")}
            hint={
              <>
                {folder && (
                  <>
                    <span className="rz-onboarding__path rz-mono">
                      {shortPath(folder)}
                    </span>
                    {" · "}
                  </>
                )}
                {tr(
                  "Je bestaande CLAUDE.md, AGENTS.md en projectbestanden blijven beschikbaar voor je assistent.",
                )}
              </>
            }
          >
            <div className="rz-onboarding__folder">
              <Input
                className="rz-mono"
                aria-label={tr("Werkmap")}
                required
                placeholder={tr("Kies je bestaande werkmap")}
                value={folder}
                onChange={(e) => setPath(e.target.value)}
              />
              <Button
                onClick={() =>
                  void run(async () => {
                    const chosen = await window.werk.selectFolder();
                    if (chosen) setPath(chosen);
                  })
                }
              >
                {tr("Kiezen…")}
              </Button>
            </div>
          </Field>
          <Field
            className="rz-onboarding__field"
            label={
              <>
                {tr("Wat doet je bedrijf?")}{" "}
                <span className="rz-onboarding__optional">
                  {tr("optioneel")}
                </span>
              </>
            }
          >
            <Textarea
              rows={3}
              placeholder={tr("Je aanbod in één zin…")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="rz-onboarding__foot">
            <Button type="submit" data-intake="true" disabled={busy}>
              {tr("Intake met assistent")}
            </Button>
            <Button
              ref={primary}
              type="submit"
              variant="primary"
              disabled={busy}
            >
              {busy ? tr("Aanmaken…") : tr("Bedrijf aanmaken")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
