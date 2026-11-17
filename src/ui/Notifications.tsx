import { t as tr } from "../shared/i18n";
import { Bell } from "lucide-react";
import { useWorkbench } from "./model";
import { waitingByCompany } from "./overview";
import { sessionTitle } from "./primitives";
import { IconButton, Menu, type MenuItem } from "./rz";

// The bell (decision D4). There is no notification feed in the data model, so this lists what really waits for
// you right now, across all companies: the same items as "Wacht op jou" on each company's Vandaag. No unread
// state, no invented counts; the dot only says "something waits outside the company you are looking at".
export function Notifications() {
  const {
    snap,
    companyId,
    workspace,
    openTask,
    openSession,
    showProposal,
    switchCompany,
  } = useWorkbench();
  const groups = waitingByCompany(snap, workspace.closedSessionIds);
  const elsewhere = groups.some((g) => g.company.id !== companyId);
  const items: MenuItem[] = groups.flatMap((g, index) => [
    ...(index
      ? [{ type: "separator" as const, id: `sep-${g.company.id}` }]
      : []),
    {
      type: "label" as const,
      id: `company-${g.company.id}`,
      label: tr("Wacht op jou bij {0}", g.company.name),
    },
    ...g.attention.map(({ task, session, kind }) => {
      const title = task?.title || sessionTitle(session!, snap);
      return {
        id: `${kind}-${task?.id || session!.id}`,
        label: title,
        title,
        hint:
          kind === "review"
            ? tr("Beoordelen")
            : kind === "waiting"
              ? tr("Antwoorden")
              : tr("Geblokkeerd"),
        onSelect: () =>
          kind === "waiting" && session
            ? openSession(session)
            : openTask(task!, kind === "review"),
      };
    }),
    ...g.proposals.map((p) => ({
      id: `proposal-${p.id}`,
      label:
        p.kind === "priorities"
          ? tr("Prioriteitenadvies beoordelen")
          : p.kind === "context"
            ? tr("Voorgestelde context bekijken")
            : tr("Voorgestelde taken bekijken"),
      hint: tr("Voorstel bekijken"),
      onSelect: () => {
        if (p.companyId !== companyId) switchCompany(p.companyId);
        showProposal(p);
      },
    })),
  ]);
  return (
    <Menu
      label={tr("Meldingen")}
      wide
      data-test="notifications-menu"
      items={
        items.length
          ? items
          : [{ type: "label", id: "empty", label: tr("Niets wacht op jou.") }]
      }
      trigger={(props) => (
        <IconButton
          {...props}
          className="rz-bell"
          variant="side"
          label={tr("Meldingen")}
          data-test="notifications"
        >
          <Bell size={16} />
          {elsewhere && (
            <i
              className="rz-dot rz-bell__dot"
              data-tone="accent"
              aria-hidden="true"
            />
          )}
        </IconButton>
      )}
    />
  );
}
