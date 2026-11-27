import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { useAppSettings } from "./appSettings";
import { installBrowserGuard } from "./browserGuard";
import { reuseRoot } from "./hotRoot";
import { I18nContext } from "./i18n";

// The backend opens every window with the same URL; the label picks the view (windows.rs): `hub`
// is the notes area, `note-<scope>-<id>` one sticky note. Each view loads only its own code.
const NotesArea = lazy(() =>
  import("./NotesArea").then((module) => ({ default: module.NotesArea })),
);
const NoteWindow = lazy(() =>
  import("./NoteWindow").then((module) => ({ default: module.NoteWindow })),
);

const NOTE_PREFIX = "note-";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // A plain browser (layout checks) has no Tauri window.
    return "hub";
  }
}

const label = windowLabel();
const sticky = label.startsWith(NOTE_PREFIX);
document.documentElement.dataset.window = sticky ? "note" : "hub";

function Root() {
  const app = useAppSettings();
  // Nothing until the settings are known, so the window never shows the wrong theme or language.
  if (!app.settings) return null;
  return (
    <I18nContext.Provider value={app.t}>
      <Suspense fallback={null}>
        {sticky ? (
          <NoteWindow
            label={label}
            theme={app.theme}
            colorNames={app.settings.colorNames}
            look={app.look}
            language={app.language}
          />
        ) : (
          <NotesArea app={app} />
        )}
      </Suspense>
    </I18nContext.Provider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Element #root missing in index.html");

const removeGuard = installBrowserGuard(window, { blockBrowserKeys: import.meta.env.PROD });
import.meta.hot?.dispose(removeGuard);

reuseRoot(import.meta.hot?.data, () => createRoot(container)).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
