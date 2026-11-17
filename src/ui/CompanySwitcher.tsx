import { t as tr } from "../shared/i18n";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "./model";
import { waitingByCompany } from "./overview";
import { companyTint } from "./primitives";
import { Badge, Menu } from "./rz";

// Replaces the company tabs (decision D2): every company is one click away, the menu says where something waits
// for you, and the closed switcher shows a dot when that is outside the company you are looking at.
export function CompanySwitcher() {
  const { snap, company, companyId, workspace, switchCompany, edit } =
    useWorkbench();
  const waiting = new Map(
    waitingByCompany(snap, workspace.closedSessionIds).map((g) => [
      g.company.id,
      g.count,
    ]),
  );
  const elsewhere = [...waiting.keys()].some((id) => id !== companyId);
  // A company tab on "Aan het werk" or ⌘⇧[ / ⌘⇧] also picks the company: the switcher lights up briefly so you
  // see that the whole menu followed.
  const [flash, setFlash] = useState(false);
  const previous = useRef(companyId),
    timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (previous.current === companyId) return;
    const first = !previous.current;
    previous.current = companyId;
    if (first) return;
    setFlash(false);
    const frame = requestAnimationFrame(() => setFlash(true));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(false), 1100);
    return () => cancelAnimationFrame(frame);
  }, [companyId]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Menu
      label={tr("Bedrijven")}
      className="rz-switcher__menu"
      data-test="company-menu"
      items={snap.companies.map((c) => ({
        id: c.id,
        label: c.name,
        icon: <Badge name={c.name} tint={companyTint(c.id, snap)} />,
        // like the tabs before: only for the companies you are not looking at
        hint:
          c.id !== companyId && waiting.has(c.id) ? (
            <span className="rz-switcher__waiting">
              <i className="rz-dot" data-tone="accent" aria-hidden="true" />
              {tr("{0} wacht op jou", waiting.get(c.id)!)}
            </span>
          ) : undefined,
        checked: c.id === companyId,
        onSelect: () => switchCompany(c.id),
      }))}
      footer={{
        label: tr("Bedrijf toevoegen"),
        icon: <Plus size={14} aria-hidden="true" />,
        onSelect: () => edit("company"),
      }}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className={flash ? "rz-switcher rz-switcher--flash" : "rz-switcher"}
          data-test="company-switcher"
          title={tr("Ander bedrijf kiezen")}
          aria-label={
            company
              ? tr("Ander bedrijf kiezen: {0}", company.name)
              : tr("Kies een bedrijf")
          }
        >
          {company && (
            <Badge name={company.name} tint={companyTint(company.id, snap)} />
          )}
          <span className="rz-switcher__name">
            {company?.name || tr("Kies een bedrijf")}
          </span>
          {elsewhere && (
            <i
              className="rz-dot rz-switcher__dot"
              data-tone="accent"
              aria-hidden="true"
            />
          )}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
    />
  );
}
