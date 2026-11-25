// Settings every window shares: language, theme and the tray texts. Each window reads them from
// the backend once and follows the `settings-changed` event; "All notes" is the only window that
// changes them.

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getSettings,
  onSettingsChanged,
  setTrayLabels,
  type Settings,
  type SettingsView,
  type ThemeSetting,
  type TrayLabels,
} from "./api";
import type { Theme } from "./colors";
import {
  createTranslator,
  detectLanguage,
  isLanguage,
  type Language,
  type Translate,
} from "./i18n";

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): Theme {
  if (setting !== "system") return setting;
  return systemDark ? "dark" : "light";
}

export function resolveLanguage(setting: Language | null, systemTag: string | undefined): Language {
  return setting !== null && isLanguage(setting) ? setting : detectLanguage(systemTag);
}

export function trayLabels(t: Translate): TrayLabels {
  return {
    allNotes: t("tray.allNotes"),
    newNote: t("tray.newNote"),
    showAll: t("tray.showAll"),
    quit: t("tray.quit"),
    tooltip: t("app.name"),
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
}

export interface AppSettings {
  /** `null` until the backend answered. */
  settings: SettingsView | null;
  theme: Theme;
  language: Language;
  t: Translate;
  /** The settings as the backend saved them, after a change in this window. */
  applySaved: (saved: Settings) => void;
  applyAutostart: (enabled: boolean) => void;
}

export function useAppSettings(): AppSettings {
  const [settings, setSettingsState] = useState<SettingsView | null>(null);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((value) => {
        if (!cancelled) setSettingsState(value);
      })
      .catch(() => {
        // Without the backend (a plain browser) the defaults apply.
        if (!cancelled) {
          setSettingsState({
            language: null,
            theme: "system",
            newNoteColor: "lemon",
            autostart: false,
          });
        }
      });
    const unlisten = onSettingsChanged((next) => {
      setSettingsState((current) => (current ? { ...current, ...next } : current));
    }).catch(() => null);
    const media = window.matchMedia(DARK_QUERY);
    const follow = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };
    media.addEventListener("change", follow);
    return () => {
      cancelled = true;
      media.removeEventListener("change", follow);
      void unlisten.then((stop) => stop?.());
    };
  }, []);

  const theme = resolveTheme(settings?.theme ?? "system", systemDark);
  const language = resolveLanguage(
    settings?.language ?? null,
    typeof navigator === "undefined" ? undefined : navigator.language,
  );
  const t = useMemo(() => createTranslator(language), [language]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    if (settings) void setTrayLabels(trayLabels(t)).catch(() => null);
  }, [language, t, settings]);

  const applySaved = useCallback((saved: Settings) => {
    setSettingsState((current) => (current ? { ...current, ...saved } : current));
  }, []);
  const applyAutostart = useCallback((enabled: boolean) => {
    setSettingsState((current) => (current ? { ...current, autostart: enabled } : current));
  }, []);

  return { settings, theme, language, t, applySaved, applyAutostart };
}
