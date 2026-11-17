import { t as tr } from "../shared/i18n";
import {
  Building2,
  Bot,
  Network,
  Folder,
  Gauge,
  Link,
  PanelLeft,
  PenLine,
  Play,
  Plus,
  Repeat,
  Settings,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { CompanySwitcher } from "./CompanySwitcher";
import { ConversationList } from "./ConversationList";
import { Notifications } from "./Notifications";
import { Brand, ThemeSwitch } from "./Theme";
import { useWorkbench } from "./model";
import { Avatar, IconButton, cx } from "./rz";

// One nav row. The counter is decorative (aria-hidden): smokes and screen readers get the plain label as the name.
function NavRow({
  icon,
  label,
  count,
  variant,
  current,
  title,
  onClick,
  disabled,
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  variant?: "project" | "foot";
  current?: boolean;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("rz-nav", variant && `rz-nav--${variant}`)}
      aria-current={current ? "page" : undefined}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span className="rz-nav__label">{label}</span>
      {!!count && (
        <span className="rz-nav__count" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
}

export function Sidebar() {
  const {
    view,
    navigate,
    prefs,
    snap,
    info,
    company,
    companyId,
    selectedTask,
    setSidebarOpen,
    sidebarOpen,
    edit,
    launch,
  } = useWorkbench();
  // One menu on every page (Eén menu, 28-09): the company switcher on top, then the open conversations and the
  // projects of the active company. The company tabs on "Aan het werk" choose that same company.
  const canvas = view === "workspace";
  const openTasks = snap.tasks.filter((task) => task.status !== "done").length;
  const active = snap.sessions.filter(
    (s) => s.alive && s.purpose === "work",
  ).length;
  // Flat list (decision D9), still in department order; the department moves into the tooltip.
  const mine = snap.projects.filter((p) => p.companyId === companyId);
  const departments = snap.departments.filter((d) => d.companyId === companyId);
  const projects = [
    ...departments.flatMap((d) =>
      mine
        .filter((p) => p.departmentId === d.id)
        .map((project) => ({ project, department: d.name })),
    ),
    ...mine
      .filter((p) => !departments.some((d) => d.id === p.departmentId))
      .map((project) => ({ project, department: "" })),
  ];
  const reviewed =
    view === "review"
      ? snap.tasks.find((t) => t.id === selectedTask)?.projectId
      : undefined;
  return (
    <aside
      className="rz-side"
      data-test="sidebar"
      aria-label={tr("Navigatie")}
      hidden={!sidebarOpen}
    >
      <div className="rz-side__head">
        <Brand />
        <div className="rz-side__icons">
          <ThemeSwitch />
          <Notifications />
          <IconButton
            variant="side"
            label={tr("Zijbalk verbergen")}
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeft size={16} />
          </IconButton>
        </div>
      </div>
      <CompanySwitcher />
      <nav className="rz-side__nav" aria-label={tr("Dagelijks werk")}>
        <NavRow
          icon={<PenLine size={18} className="rz-side__accent" />}
          label={tr("Nieuw gesprek")}
          title={company ? tr("Nieuw gesprek bij {0}", company.name) : undefined}
          onClick={() => launch({ mode: "work", companyId })}
        />
        <NavRow
          icon={<Sun size={18} />}
          label={tr("Dashboard")}
          count={openTasks}
          current={view === "today"}
          onClick={() => navigate("today")}
        />
        <NavRow
          icon={<Play size={18} />}
          label={tr("Aan het werk")}
          count={active}
          current={canvas}
          onClick={() => navigate("workspace")}
        />
        <NavRow
          icon={<Network size={18} />}
          label={tr("Bedrijfsbrein")}
          current={view === "brain"}
          onClick={() => navigate("brain")}
        />
        <NavRow
          icon={<Bot size={18} />}
          label={tr("Agents")}
          current={view === "agents" || view.startsWith("agent:")}
          onClick={() => navigate("agents")}
        />
      </nav>
      <div className="rz-side__label">{tr("Gesprekken")}</div>
      <ConversationList />
      <div className="rz-side__label">
        <button
          type="button"
          className="rz-side__label-link"
          aria-current={view === "projects" ? "page" : undefined}
          onClick={() => navigate("projects")}
        >
          {tr("Projecten")}
        </button>
        <IconButton
          size="xs"
          label={tr("Nieuw project")}
          onClick={() => edit("project")}
        >
          <Plus size={13} />
        </IconButton>
      </div>
      <div className="rz-side__projects" data-test="sidebar-projects">
        {projects.map(({ project, department }) => (
          <NavRow
            key={project.id}
            variant="project"
            icon={<Folder size={17} />}
            label={project.name}
            title={
              department ? `${department} › ${project.name}` : project.name
            }
            count={
              snap.tasks.filter(
                (t) => t.projectId === project.id && t.status !== "done",
              ).length
            }
            current={view === project.id || reviewed === project.id}
            onClick={() => navigate(project.id)}
          />
        ))}
      </div>
      <div className="rz-side__foot">
        {info.browser && info.preview && (
          <div className="rz-side__preview">{tr("Voorbeeldgegevens")}</div>
        )}
        <div className="rz-side__bottom">
          <nav className="rz-side__manage" aria-label={tr("Beheer")}>
            <NavRow
              variant="foot"
              icon={<Building2 size={17} />}
              label={tr("Je bedrijf")}
              current={view === "company"}
              onClick={() => navigate("company")}
            />
            <NavRow
              variant="foot"
              icon={<Link size={17} />}
              label={tr("Koppelingen")}
              current={view === "integrations"}
              onClick={() => navigate("integrations")}
            />
            <NavRow
              variant="foot"
              icon={<Repeat size={17} />}
              label={tr("Terugkerend")}
              current={view === "schedules"}
              onClick={() => navigate("schedules")}
            />
            <NavRow
              variant="foot"
              icon={<Gauge size={17} />}
              label={tr("Accounts & gebruik")}
              current={view === "accounts"}
              onClick={() => navigate("accounts")}
            />
          </nav>
          <button
            type="button"
            className="rz-user"
            aria-label={tr("Profiel en instellingen")}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <Avatar name={prefs.profile.name || tr("Jij")} />
            <span className="rz-user__text">
              <span className="rz-user__name">
                {prefs.profile.name || tr("Jouw profiel")}
              </span>
              <span className="rz-user__role">{tr("Eigenaar")}</span>
            </span>
            <Settings size={16} className="rz-user__gear" />
          </button>
        </div>
      </div>
    </aside>
  );
}
