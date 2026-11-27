// The three levels as one segmented control at the top of the sidebar, the same in every look:
// "Private", "Project", "Team". The tabs are one Tab stop; Left, Right, Home and End move between
// them and choose (useNotesArea.tsx holds what each level shows, Ctrl+1 to Ctrl+3 choose from
// anywhere). While "Project" is chosen, a small line below names its project (Hangar's working
// folder); with more than one project, that line, a click on the chosen tab, Down or Enter open
// the menu that switches the project.

import { useRef, useState } from "react";

import { ChevronDownIcon, FolderIcon, TeamIcon } from "./icons";
import type { Level } from "./notesScope";
import { tabTarget } from "./shortcuts";
import type { NotesModel } from "./useNotesArea";

export const levelTabId = (level: Level) => `level-tab-${level}`;
export const LEVEL_PANEL_ID = "level-panel";

/** `onChosen`: a level was chosen with the pointer (the sidebar over the notes then closes). */
export function LevelBar({ m, onChosen }: { m: NotesModel; onChosen?: () => void }) {
  const { t } = m;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  /** The tab that takes the bar's one Tab stop: the last focused, else the chosen one. */
  const [focused, setFocused] = useState<number | null>(null);
  const chosenIndex = m.levelTabs.findIndex((tab) => tab.level === m.level);
  const stop = focused ?? (chosenIndex < 0 ? 0 : chosenIndex);
  const switchable = m.projectEntries.length > 1;

  const openProjects = (anchor: HTMLElement) => {
    if (switchable) m.openMenu("project", anchor);
  };

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLButtonElement>) => {
    const tab = m.levelTabs[index];
    if (tab?.level === "project" && switchable) {
      const opens =
        event.key === "ArrowDown" ||
        ((event.key === "Enter" || event.key === " ") && m.level === "project");
      if (opens) {
        event.preventDefault();
        if (m.level !== "project") m.chooseLevel("project");
        openProjects(event.currentTarget);
        return;
      }
    }
    const next = tabTarget(event, index, m.levelTabs.length);
    const target = next === null ? undefined : m.levelTabs[next];
    if (next === null || target === undefined) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    m.chooseLevel(target.level);
  };

  return (
    <div className="level-bar">
      <div className="level-tabs" role="tablist" aria-label={t("level.tabs")}>
        {m.levelTabs.map((tab, index) => {
          const selected = tab.level === m.level;
          const isProjectTab = tab.level === "project";
          const menuShown = isProjectTab && m.menuOpen("project");
          return (
            <button
              key={tab.level}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={levelTabId(tab.level)}
              className={`level-tab level-${tab.level}`}
              aria-selected={selected}
              aria-controls={selected ? LEVEL_PANEL_ID : undefined}
              aria-haspopup={isProjectTab && switchable ? "menu" : undefined}
              aria-expanded={isProjectTab && switchable ? menuShown : undefined}
              tabIndex={index === stop ? 0 : -1}
              title={tab.title}
              onFocus={() => {
                setFocused(index);
              }}
              onBlur={() => {
                setFocused(null);
              }}
              onKeyDown={(event) => {
                onKeyDown(index, event);
              }}
              onClick={(event) => {
                const onChevron =
                  event.target instanceof Element &&
                  event.target.closest(".level-chevron") !== null;
                if (isProjectTab && switchable && (selected || onChevron)) {
                  if (!selected) m.chooseLevel("project");
                  openProjects(event.currentTarget);
                  return;
                }
                m.chooseLevel(tab.level);
                onChosen?.();
              }}
            >
              {tab.level === "team" && <TeamIcon size={14} />}
              <span className="level-label">{tab.short}</span>
            </button>
          );
        })}
      </div>
      {m.level === "project" && m.projectName !== null && (
        <button
          type="button"
          className="level-project-name"
          title={m.project?.path ?? undefined}
          disabled={!switchable}
          aria-haspopup={switchable ? "menu" : undefined}
          aria-expanded={switchable ? m.menuOpen("project") : undefined}
          aria-label={switchable ? `${t("level.switchProject")}: ${m.projectName}` : undefined}
          onClick={(event) => {
            openProjects(event.currentTarget);
          }}
        >
          <FolderIcon size={13} />
          <span className="level-label">{m.projectName}</span>
          {switchable && <ChevronDownIcon size={12} />}
        </button>
      )}
    </div>
  );
}

/**
 * The team level. Team notes are opened through Hangar, which is not connected yet (`m.team`):
 * one calm sentence says what is needed, nothing read only, no notes that are not there.
 */
export function TeamLevel({ m }: { m: NotesModel }) {
  const { t } = m;
  // `m.team` has one state so far ("needsHangar"); a connected one adds its list here.
  return (
    <div className="team-level" data-team={m.team.kind}>
      <div className="team-empty">
        <span className="team-mark" aria-hidden="true">
          <TeamIcon size={28} />
        </span>
        <h1 className="team-title">{t("team.title")}</h1>
        <p>{t("team.needsHangar")}</p>
      </div>
    </div>
  );
}
