import { changeLanguage, useLanguage } from "./language";
import type { Language } from "../shared/i18n";
import { t as tr, locale, translateMessage } from "../shared/i18n";
import { terminalTheme, type TerminalPreset } from "../shared/terminal-theme";
import type { UserProfile } from "../shared/types";
import {
  applyTheme,
  setDesign,
  setTheme,
  useDesign,
  storeTerminalPreferences,
  useTheme,
} from "./Theme";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Check as CheckIcon, ChevronRight, RefreshCw } from "lucide-react";
import { api, useWorkbench } from "./model";
import { providerName, shortPath } from "./primitives";
import { exportBackup } from "./settings-actions";
import {
  Avatar,
  Button,
  Check,
  Chip,
  Field,
  Input,
  PageHead,
  PageShell,
  Row,
  RowEnd,
  RowText,
  Section,
  SectionLabel,
  StatusDot,
  Tabs,
} from "./rz";

type SettingsTab = "profile" | "environment" | "storage";
// What choosing a preset resets the two sliders to; the sample of a preset that is not selected uses them too.
const presetDefaults: Record<
  TerminalPreset,
  { terminalFontSize: number; terminalLineHeight: number }
> = {
  classic: { terminalFontSize: 13, terminalLineHeight: 1.4 },
  refined: { terminalFontSize: 14, terminalLineHeight: 1.55 },
  compact: { terminalFontSize: 12.5, terminalLineHeight: 1.3 },
};

export function Profile() {
  const language = useLanguage();
  const theme = useTheme();
  const design = useDesign();
  const {
    prefs,
    company,
    info,
    run,
    notice,
    refreshPreferences,
    shortcuts,
    inventory,
    inspect,
    inspecting,
    navigate,
  } = useWorkbench();
  const [tab, setTab] = useState<SettingsTab>("profile"),
    [profile, setProfile] = useState(prefs.profile);
  const id = useId();
  const saveProfile = async (value = profile) => {
    storeTerminalPreferences(value);
    await run(async () => {
      await api("profile.save", { value });
      await refreshPreferences();
    });
  };
  const updateProfile = (patch: Partial<typeof profile>, save = true) => {
    const next = { ...profile, ...patch };
    setProfile(next);
    if (save) void saveProfile(next);
    return next;
  };
  useEffect(() => {
    if (!inventory) void inspect();
  }, []);
  // The theme button in the sidebar saves the appearance as well: follow it, so a later save from this page
  // does not put the old appearance back.
  useEffect(() => {
    setProfile((current) =>
      current.appearance === prefs.profile.appearance
        ? current
        : { ...current, appearance: prefs.profile.appearance },
    );
  }, [prefs.profile.appearance]);
  // A restored back-up replaces the whole profile: take it over, or the next change here would save the old one.
  const adopt = useRef(false);
  useEffect(() => {
    if (!adopt.current) return;
    adopt.current = false;
    setProfile(prefs.profile);
  }, [prefs.profile]);
  const exportData = () =>
    void run(async () => {
      return exportBackup(
        () => window.werk.backup(),
        () => notice(tr("Bedrijfsgegevens geëxporteerd.")),
      );
    });
  const chooseAppearance = (appearance: UserProfile["appearance"]) => {
    setTheme(
      appearance === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : appearance,
    );
    updateProfile({ appearance });
  };
  const choosePreset = (preset: TerminalPreset) => {
    const next = updateProfile(
      { terminalPreset: preset, ...presetDefaults[preset] },
      false,
    );
    localStorage.setItem("benchdesk-terminal-preset", preset);
    applyTheme(localStorage.getItem("benchdesk-theme") || "light", preset);
    void saveProfile(next);
  };
  const presets: { id: TerminalPreset; label: string; description: string }[] =
    [
      {
        id: "classic",
        label: tr("Huidig"),
        description: tr("Bekend en direct"),
      },
      {
        id: "refined",
        label: tr("Verfijnd"),
        description: tr("Rust en ruimte"),
      },
      {
        id: "compact",
        label: tr("Compact"),
        description: tr("Meer in beeld"),
      },
    ];
  const presetKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const at = presets.findIndex((p) => p.id === profile.terminalPreset),
      next = (at + step + presets.length) % presets.length;
    choosePreset(presets[next].id);
    event.currentTarget
      .querySelectorAll<HTMLElement>('[role="radio"]')
      [next]?.focus();
  };
  // The sample is drawn with the palette xterm really gets (terminalTheme) and, for the chosen preset, with the
  // font, size and line-height of the sliders (13px terminal text = 10px in the sample).
  const sampleStyle = (preset: TerminalPreset) => {
    const palette = terminalTheme(preset, theme === "dark" ? "dark" : "light"),
      text =
        preset === profile.terminalPreset ? profile : presetDefaults[preset];
    return {
      "--rz-profile-term-bg": palette.background,
      "--rz-profile-term-fg": palette.foreground,
      "--rz-profile-term-prompt":
        preset === "classic" ? palette.blue : palette.cursor,
      "--rz-profile-term-ok": palette.green,
      fontFamily:
        profile.terminalFont === "plex"
          ? '"IBM Plex Mono", Menlo, monospace'
          : "ui-monospace, Menlo, monospace",
      fontSize: `${Math.round((text.terminalFontSize / 1.3) * 10) / 10}px`,
      lineHeight: text.terminalLineHeight,
    } as CSSProperties;
  };
  const name = profile.name || tr("Jouw profiel");
  const days = [
    tr("Zondag"),
    tr("Maandag"),
    tr("Dinsdag"),
    tr("Woensdag"),
    tr("Donderdag"),
    tr("Vrijdag"),
    tr("Zaterdag"),
  ];
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "profile", label: tr("Profiel") },
    { id: "environment", label: tr("Omgeving") },
    { id: "storage", label: tr("Opslag & back-ups") },
  ];
  return (
    <PageShell data-test="settings-page">
      <PageHead
        badge={<Avatar name={name} />}
        title={name}
        meta={
          <span title={tr("Benchdesk {0}", info.version)}>
            {info.platform === "darwin"
              ? tr("Instellingen · lokaal op deze Mac")
              : tr("Instellingen · lokaal op deze computer")}
          </span>
        }
      />
      <Tabs
        label={tr("Instellingen")}
        tabs={tabs}
        value={tab}
        onChange={setTab}
        data-test="settings-tabs"
      />
      {tab === "profile" && (
        <div
          className="rz-profile__panel"
          role="tabpanel"
          aria-label={tr("Profiel")}
        >
          <Section tight>
            <div className="rz-profile__intro">
              <span>{tr("Wie je bent en hoe Benchdesk eruitziet.")}</span>
            </div>
            <div className="rz-profile__row">
              <label className="rz-profile__key" htmlFor={`${id}-name`}>
                {tr("Naam")}
              </label>
              <div className="rz-profile__value">
                <Input
                  id={`${id}-name`}
                  className="rz-profile__input"
                  value={profile.name}
                  placeholder={tr("Je naam")}
                  onChange={(e) =>
                    setProfile({ ...profile, name: e.target.value })
                  }
                  onBlur={() => void saveProfile()}
                />
              </div>
            </div>
            <div className="rz-profile__row">
              <label className="rz-profile__key" htmlFor={`${id}-email`}>
                {tr("E-mail")}
              </label>
              <div className="rz-profile__value">
                <Input
                  id={`${id}-email`}
                  className="rz-profile__input"
                  type="email"
                  value={profile.email}
                  placeholder={tr("Je e-mailadres")}
                  onChange={(e) =>
                    setProfile({ ...profile, email: e.target.value })
                  }
                  onBlur={() => void saveProfile()}
                />
              </div>
            </div>
            <div className="rz-profile__row">
              <label className="rz-profile__key" htmlFor={`${id}-language`}>
                {tr("Taal")}
              </label>
              <div className="rz-profile__value">
                <Chip
                  chevron
                  control={
                    <select
                      id={`${id}-language`}
                      aria-label={tr("Taal")}
                      value={language}
                      onChange={(e) =>
                        changeLanguage(e.target.value as Language)
                      }
                    >
                      <option value="nl">Nederlands</option>
                      <option value="en">English</option>
                    </select>
                  }
                >
                  {language === "en" ? "English" : "Nederlands"}
                </Chip>
              </div>
            </div>
            <div className="rz-profile__row">
              <span className="rz-profile__key">{tr("Weergave")}</span>
              <div
                className="rz-profile__value"
                role="group"
                aria-label={tr("Weergave")}
              >
                {(
                  [
                    ["light", tr("Licht")],
                    ["dark", tr("Donker")],
                    ["system", tr("Systeem")],
                  ] as const
                ).map(([appearance, label]) => (
                  <Chip
                    key={appearance}
                    variant="toggle"
                    pressed={profile.appearance === appearance}
                    onClick={() => chooseAppearance(appearance)}
                  >
                    {label}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="rz-profile__row">
              <span className="rz-profile__key">{tr("Stijl")}</span>
              <div
                className="rz-profile__value"
                role="group"
                aria-label={tr("Stijl")}
              >
                {(
                  [
                    ["shadcn", tr("shadcn")],
                    ["standaard", tr("Rustig")],
                    ["minimaal", tr("Minimaal")],
                  ] as const
                ).map(([value, label]) => (
                  <Chip
                    key={value}
                    variant="toggle"
                    pressed={design === value}
                    onClick={() => setDesign(value)}
                  >
                    {label}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="rz-profile__row">
              <span
                className="rz-profile__key"
                title={tr("Weekstart voor check-ins")}
              >
                {tr("Check-in")}
              </span>
              <div className="rz-profile__value">
                <Chip
                  chevron
                  control={
                    <select
                      aria-label={tr("Weekstart")}
                      value={profile.weekStart}
                      onChange={(e) =>
                        updateProfile({ weekStart: Number(e.target.value) })
                      }
                    >
                      {days.map((day, index) => (
                        <option value={index} key={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  }
                >
                  {days[profile.weekStart]}
                </Chip>
                <input
                  className="rz-profile__time"
                  aria-label={tr("Tijd voor check-in")}
                  type="time"
                  value={profile.checkinTime}
                  onChange={(e) => {
                    if (e.target.value)
                      updateProfile({ checkinTime: e.target.value });
                  }}
                />
                <span className="rz-profile__remind">
                  <Check
                    shape="square"
                    size="xs"
                    checked={profile.checkinReminder}
                    label={tr("Herinnering op Vandaag")}
                    onChange={(checkinReminder) =>
                      updateProfile({ checkinReminder })
                    }
                  />
                  <span
                    className="rz-profile__remind-text"
                    aria-hidden="true"
                    onClick={() =>
                      updateProfile({
                        checkinReminder: !profile.checkinReminder,
                      })
                    }
                  >
                    {tr("Herinnering op Vandaag")}
                  </span>
                </span>
              </div>
            </div>
          </Section>
          <Section>
            {/* The status sits NEXT to the h2, not inside it: the heading's name stays "Weergave van gesprekken". */}
            <div className="rz-profile__labelrow">
              <SectionLabel as="h2">
                {tr("Weergave van gesprekken")}
              </SectionLabel>
              <span className="rz-profile__label-right">
                {tr("Live toegepast")}
              </span>
            </div>
            <p className="rz-profile__note">
              {tr("Kies de uitstraling en leesbaarheid van je gesprekken.")}
            </p>
            <div
              className="rz-profile__presets"
              role="radiogroup"
              aria-label={tr("Thema voor gesprekken")}
              onKeyDown={presetKeys}
            >
              {presets.map((preset) => {
                const checked = profile.terminalPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    className="rz-profile__preset"
                    data-preset={preset.id}
                    onClick={() => choosePreset(preset.id)}
                  >
                    <span
                      className="rz-profile__sample"
                      style={sampleStyle(preset.id)}
                      aria-hidden="true"
                    >
                      <span>
                        <span className="rz-profile__sample-prompt">❯</span>
                        {/* Minimaal: a work sentence instead of a build command (no tech jargon on screen) */}
                        {design === "minimaal"
                          ? ` ${tr("Maak drie voorstellen")}`
                          : " npm run build"}
                      </span>
                      <span className="rz-profile__sample-ok">
                        {tr("✓ Gereed in 1,8s")}
                      </span>
                    </span>
                    <span className="rz-profile__preset-foot">
                      <span className="rz-profile__preset-text">
                        <span className="rz-profile__preset-name">
                          {preset.label}
                        </span>
                        <span className="rz-profile__preset-sub">
                          {preset.description}
                        </span>
                      </span>
                      <span
                        className="rz-radio"
                        data-on={checked ? "" : undefined}
                        aria-hidden="true"
                      >
                        {checked && <CheckIcon size={9} />}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="rz-profile__tuning">
              <Field as="div" label={tr("Lettertype")}>
                <Chip
                  className="rz-profile__tuning-chip"
                  chevron
                  control={
                    <select
                      aria-label={tr("Lettertype")}
                      value={profile.terminalFont}
                      onChange={(e) =>
                        updateProfile({
                          terminalFont: e.target
                            .value as typeof profile.terminalFont,
                        })
                      }
                    >
                      <option value="plex">IBM Plex Mono</option>
                      <option value="system">{tr("Systeem / Menlo")}</option>
                    </select>
                  }
                >
                  {profile.terminalFont === "plex"
                    ? "IBM Plex Mono"
                    : tr("Systeem / Menlo")}
                </Chip>
              </Field>
              <Field
                label={
                  <span className="rz-profile__range-top">
                    <span>{tr("Tekstgrootte")}</span>
                    <output>
                      {profile.terminalFontSize.toLocaleString(locale())} px
                    </output>
                  </span>
                }
              >
                <input
                  className="rz-profile__range"
                  aria-label={tr("Tekstgrootte van gesprekken")}
                  type="range"
                  min="11"
                  max="17"
                  step="0.5"
                  value={profile.terminalFontSize}
                  onChange={(e) =>
                    updateProfile(
                      { terminalFontSize: Number(e.target.value) },
                      false,
                    )
                  }
                  onPointerUp={(e) =>
                    updateProfile({
                      terminalFontSize: Number(e.currentTarget.value),
                    })
                  }
                  onBlur={(e) =>
                    updateProfile({
                      terminalFontSize: Number(e.currentTarget.value),
                    })
                  }
                />
              </Field>
              <Field
                label={
                  <span className="rz-profile__range-top">
                    <span>{tr("Regelafstand")}</span>
                    <output>
                      {profile.terminalLineHeight.toLocaleString(locale())}
                    </output>
                  </span>
                }
              >
                <input
                  className="rz-profile__range"
                  aria-label={tr("Regelafstand van gesprekken")}
                  type="range"
                  min="1.1"
                  max="1.8"
                  step="0.05"
                  value={profile.terminalLineHeight}
                  onChange={(e) =>
                    updateProfile(
                      { terminalLineHeight: Number(e.target.value) },
                      false,
                    )
                  }
                  onPointerUp={(e) =>
                    updateProfile({
                      terminalLineHeight: Number(e.currentTarget.value),
                    })
                  }
                  onBlur={(e) =>
                    updateProfile({
                      terminalLineHeight: Number(e.currentTarget.value),
                    })
                  }
                />
              </Field>
            </div>
            <p className="rz-profile__note">
              {tr(
                "Kleur, cursor en witruimte volgen het gekozen thema. De inhoud van je gesprekken blijft hetzelfde.",
              )}
            </p>
          </Section>
          <Section tight>
            <SectionLabel as="h2">{tr("Meer")}</SectionLabel>
            <Row
              as="button"
              size="sm"
              cols="minmax(0, 1fr) auto"
              aria-label={tr("Accounts & gebruik openen")}
              onClick={() => navigate("accounts")}
            >
              <RowText
                title={tr("Accounts & gebruik")}
                meta={tr(
                  "Bekijk je gebruik, log in of kies een standaard per bedrijf.",
                )}
              />
              <ChevronRight
                className="rz-profile__row-icon"
                size={14}
                aria-hidden="true"
              />
            </Row>
            <Row
              as="button"
              size="sm"
              cols="minmax(0, 1fr) auto"
              title={info.platform === "darwin" ? "⌘/" : "Ctrl+/"}
              onClick={shortcuts}
            >
              <RowText title={tr("Sneltoetsen bekijken")} />
              <ChevronRight
                className="rz-profile__row-icon"
                size={14}
                aria-hidden="true"
              />
            </Row>
            <Row
              as="button"
              size="sm"
              cols="minmax(0, 1fr) auto"
              onClick={exportData}
            >
              <RowText title={tr("Exporteer alle bedrijfsgegevens")} />
              <ChevronRight
                className="rz-profile__row-icon"
                size={14}
                aria-hidden="true"
              />
            </Row>
            <p className="rz-profile__note">
              {tr("Wijzigingen worden automatisch opgeslagen.")}
            </p>
          </Section>
        </div>
      )}
      {tab === "environment" && (
        <div
          className="rz-profile__panel"
          role="tabpanel"
          aria-label={tr("Omgeving")}
        >
          <Section tight data-test="settings-providers">
            <div className="rz-profile__intro">
              <span>{tr("De tools en configuratie waarmee je al werkt.")}</span>
              <Button
                icon={<RefreshCw size={13} aria-hidden="true" />}
                disabled={inspecting}
                onClick={() => void inspect()}
              >
                {inspecting ? tr("Controleren…") : tr("Omgeving bekijken")}
              </Button>
            </div>
            {inventory && (
              <>
                <SectionLabel as="h2">{tr("Assistenten")}</SectionLabel>
                {inventory.providers.map((p) => (
                  <Row
                    as="div"
                    quiet
                    size="sm"
                    key={p.name}
                    title={
                      [p.version, p.path].filter(Boolean).join(" · ") ||
                      undefined
                    }
                  >
                    <Avatar provider={p.name} name={providerName(p.name)} />
                    <RowText
                      title={providerName(p.name)}
                      meta={
                        p.path ? (
                          // Minimaal: the folder stays in the row's tooltip (version · path)
                          design === "minimaal" ? undefined : (
                            <span className="rz-profile__path rz-profile__path--quiet">
                              {shortPath(p.path, info.homeDir)}
                            </span>
                          )
                        ) : (
                          tr("Installeer de CLI om te beginnen.")
                        )
                      }
                    />
                    <RowEnd>
                      <StatusDot
                        tone={p.path ? "accent" : "warn"}
                        label={
                          p.path
                            ? tr("Gevonden")
                            : tr("Niet gevonden in je login-shell")
                        }
                      />
                    </RowEnd>
                  </Row>
                ))}
              </>
            )}
          </Section>
          {inventory && (
            <>
              <Section tight data-test="settings-mcps">
                <div className="rz-profile__labelrow">
                  <SectionLabel as="h2">{tr("MCP-servers")}</SectionLabel>
                  <span className="rz-profile__label-right">
                    {tr("{0} gevonden", inventory.mcps.length)}
                  </span>
                </div>
                <p className="rz-profile__note">
                  {inventory.mcps.length
                    ? tr(
                        "Gevonden configuratie voor {0}. Verbindingen en toegangsrechten beheer je in de CLI.",
                        company?.name || tr("je eigen omgeving"),
                      )
                    : tr("Geen MCP-servers gevonden.")}
                </p>
                {inventory.mcps.map((m, i) => (
                  <Row
                    as="div"
                    quiet
                    size="sm"
                    cols="6px minmax(0, 1fr) auto"
                    title={design === "minimaal" ? m.source : undefined}
                    key={i}
                  >
                    <StatusDot tone={m.enabled ? "accent" : "muted"} />
                    <RowText
                      title={m.name}
                      meta={
                        <>
                          {providerName(m.provider)} ·{" "}
                          {m.enabled ? tr("ingeschakeld") : tr("uitgeschakeld")}
                        </>
                      }
                    />
                    {design !== "minimaal" && (
                      <span
                        className="rz-profile__path rz-profile__path--quiet rz-profile__path--end"
                        title={m.source}
                      >
                        {shortPath(m.source, info.homeDir)}
                      </span>
                    )}
                  </Row>
                ))}
              </Section>
              <Section tight data-test="settings-skills">
                <SectionLabel as="h2">{tr("Skillmappen")}</SectionLabel>
                {!inventory.skills.length && (
                  <p className="rz-profile__note">
                    {tr("Geen skillmappen gevonden.")}
                  </p>
                )}
                {inventory.skills.map((s) => (
                  <Row
                    as="div"
                    quiet
                    size="sm"
                    cols="minmax(0, 1fr) auto"
                    title={design === "minimaal" ? s.path : undefined}
                    key={s.path}
                  >
                    <RowText
                      title={tr("{0} skills", s.count)}
                      meta={
                        design === "minimaal" ? undefined : (
                          <span
                            className="rz-profile__path rz-profile__path--quiet"
                            title={s.path}
                          >
                            {shortPath(s.path, info.homeDir)}
                          </span>
                        )
                      }
                    />
                    <RowEnd>{translateMessage(s.provider)}</RowEnd>
                  </Row>
                ))}
              </Section>
            </>
          )}
        </div>
      )}
      {tab === "storage" && (
        <div
          className="rz-profile__panel"
          role="tabpanel"
          aria-label={tr("Opslag & back-ups")}
        >
          <Section tight>
            <div className="rz-profile__intro">
              <span>
                {tr(
                  "Bedrijfsgegevens, gesprekken en back-ups op deze computer.",
                )}
              </span>
            </div>
            <div className="rz-deflist">
              <span className="rz-deflist__k">{tr("Lokale gegevens")}</span>
              <span className="rz-deflist__v">
                <span className="rz-profile__path" title={info.dataDir}>
                  {shortPath(info.dataDir, info.homeDir)}
                </span>
              </span>
            </div>
            <div className="rz-profile__actions">
              <Button variant="primary" onClick={exportData}>
                {tr("Back-up maken")}
              </Button>
              <Button
                onClick={() =>
                  void run(async () => {
                    if (await window.werk.restore()) {
                      adopt.current = true;
                      await refreshPreferences();
                    }
                  })
                }
              >
                {tr("Back-up herstellen")}
              </Button>
            </div>
            <p className="rz-profile__note">
              {tr(
                "Een back-up bevat bedrijfsgegevens, criteria, opmerkingen en bestandsverwijzingen. Neem je werkmappen en documenten mee in je eigen back-up. Inloggegevens blijven bij de CLI.",
              )}
            </p>
          </Section>
        </div>
      )}
    </PageShell>
  );
}
