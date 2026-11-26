// The settings of the notes area: language, theme, the look (ADR 0004), the color of new notes,
// the person's own names of the eight colors (ADR 0002, "Color categories") and "Start with the
// system". A change is saved at once and takes effect at once in every window.

import { useId, useState } from "react";

import { setAutostart, setSettings, type Settings, type ThemeSetting } from "./api";
import type { AppSettings } from "./appSettings";
import { errorMessage } from "./errors";
import { colorLabelKey, colorName, NOTE_COLORS, swatchColor, type NoteColor } from "./colors";
import { LANGUAGE_NAMES, LANGUAGES, useT, type MessageKey } from "./i18n";
import { BackIcon, CheckIcon } from "./icons";
import { LOOK_HINTS, LOOK_NAMES, LOOKS, type Look } from "./looks";

/** The backend's limit (`MAX_COLOR_NAME_CHARS` in settings.rs). */
export const MAX_COLOR_NAME_LENGTH = 40;

const THEMES: readonly { value: ThemeSetting; label: MessageKey }[] = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

/** The names with `color` set to `name`; a blank name removes the color's own name. */
export function withColorName(
  names: Partial<Record<NoteColor, string>>,
  color: NoteColor,
  name: string,
): Partial<Record<NoteColor, string>> {
  const clean = Array.from(name.replace(/\s+/g, " ").trim())
    .slice(0, MAX_COLOR_NAME_LENGTH)
    .join("");
  const next: Partial<Record<NoteColor, string>> = {};
  for (const other of NOTE_COLORS) {
    const value = other === color ? clean : names[other];
    if (value !== undefined && value !== "") next[other] = value;
  }
  return next;
}

/** The sentence for a failed change: the code's own one (errors.ts), else the general one. */
export function settingsError(error: unknown): MessageKey {
  const message = errorMessage(error, "action");
  return message === null || message.key === "error.failed" ? "settings.failed" : message.key;
}

export function NotesSettings({ app, onBack }: { app: AppSettings; onBack: () => void }) {
  const t = useT();
  /** The sentence of the last failed change, `null` while everything worked. */
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const hintId = useId();
  const { settings, applySaved, applyAutostart } = app;
  if (!settings) return null;

  const save = (change: Partial<Settings>) => {
    const next: Settings = {
      language: settings.language,
      theme: settings.theme,
      newNoteColor: settings.newNoteColor,
      colorNames: settings.colorNames,
      look: app.look,
      ...change,
    };
    setSettings(next)
      .then((saved) => {
        applySaved(saved);
        setFailed(null);
      })
      .catch((e: unknown) => {
        setFailed(settingsError(e));
      });
  };

  const saveName = (color: NoteColor, value: string) => {
    const names = withColorName(settings.colorNames, color, value);
    if (names[color] === settings.colorNames[color]) return;
    save({ colorNames: names });
  };

  return (
    <>
      <header className="pane-head">
        <button
          type="button"
          className="icon-button"
          aria-label={t("notes.back")}
          title={t("notes.back")}
          onClick={onBack}
        >
          <BackIcon />
        </button>
        <h1>{t("notes.settings")}</h1>
      </header>
      <div className="list-wrap single-wrap settings">
        <label className="field">
          <span>{t("settings.language")}</span>
          <select
            value={settings.language ?? ""}
            onChange={(event) => {
              const value = LANGUAGES.find((code) => code === event.target.value) ?? null;
              save({ language: value });
            }}
          >
            <option value="">{t("settings.languageSystem")}</option>
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_NAMES[code]}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="field">
          <legend>{t("settings.theme")}</legend>
          <div className="segmented">
            {THEMES.map(({ value, label }) => (
              <label key={value} className={settings.theme === value ? "selected" : ""}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={settings.theme === value}
                  onChange={() => {
                    save({ theme: value });
                  }}
                />
                {t(label)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>{t("settings.look")}</legend>
          {/* Native radios: the arrow keys move through the three, and each choice applies at once. */}
          <div className="look-cards">
            {LOOKS.map((look) => (
              <label key={look} className={app.look === look ? "look-card selected" : "look-card"}>
                <input
                  type="radio"
                  name="look"
                  value={look}
                  checked={app.look === look}
                  aria-label={t(LOOK_NAMES[look])}
                  aria-describedby={`${hintId}-${look}`}
                  onChange={() => {
                    save({ look });
                  }}
                />
                <LookPreview look={look} />
                <span className="look-name">
                  {t(LOOK_NAMES[look])}
                  {app.look === look && <CheckIcon size={14} />}
                </span>
                <span className="look-hint" id={`${hintId}-${look}`}>
                  {t(LOOK_HINTS[look])}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>{t("settings.newNoteColor")}</legend>
          <div className="swatches" role="radiogroup">
            {NOTE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={settings.newNoteColor === color}
                className="swatch"
                title={colorName(color, settings.colorNames, t)}
                aria-label={colorName(color, settings.colorNames, t)}
                style={{ background: swatchColor(color) }}
                onClick={() => {
                  save({ newNoteColor: color });
                }}
              >
                {settings.newNoteColor === color && <CheckIcon size={14} />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>{t("settings.colorNames")}</legend>
          <p className="field-hint">{t("settings.colorNamesHint")}</p>
          <div className="color-names">
            {NOTE_COLORS.map((color) => (
              <label key={color} className="color-name">
                <span
                  className="swatch small"
                  aria-hidden="true"
                  style={{ background: swatchColor(color) }}
                />
                <input
                  // A new key after each save, so the field shows what was stored.
                  key={settings.colorNames[color] ?? ""}
                  type="text"
                  defaultValue={settings.colorNames[color] ?? ""}
                  placeholder={t(colorLabelKey(color))}
                  aria-label={t("settings.colorNameOf", { color: t(colorLabelKey(color)) })}
                  maxLength={MAX_COLOR_NAME_LENGTH}
                  onBlur={(event) => {
                    saveName(color, event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveName(color, event.currentTarget.value);
                    }
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <label className="check-field">
          <input
            type="checkbox"
            checked={settings.autostart}
            onChange={(event) => {
              const enabled = event.target.checked;
              setAutostart(enabled)
                .then((now) => {
                  applyAutostart(now);
                  setFailed(null);
                })
                .catch((e: unknown) => {
                  setFailed(settingsError(e));
                });
            }}
          />
          {t("settings.autostart")}
        </label>

        {failed !== null && <p className="notes-message error-text">{t(failed)}</p>}
      </div>
    </>
  );
}

/** A small drawing of a look, in the colors of the current theme; decoration only. */
function LookPreview({ look }: { look: Look }) {
  return (
    <span className={`look-preview look-preview-${look}`} aria-hidden="true">
      {look === "calm" && (
        <>
          <span className="lp-list">
            <i className="lp-row lp-lemon" />
            <i className="lp-row lp-sky" />
            <i className="lp-row lp-mint" />
          </span>
          <span className="lp-page">
            <i className="lp-line wide" />
            <i className="lp-line" />
            <i className="lp-line short" />
          </span>
        </>
      )}
      {look === "paper" && (
        <>
          <i className="lp-card lp-lemon" />
          <i className="lp-card lp-sky" />
          <i className="lp-card lp-rose" />
          <i className="lp-card lp-mint" />
        </>
      )}
      {look === "hangar" && (
        <>
          <span className="lp-side">
            <i className="lp-line" />
            <i className="lp-line short" />
            <i className="lp-line" />
          </span>
          <span className="lp-list">
            <i className="lp-row lp-lemon" />
            <i className="lp-row lp-sky" />
            <i className="lp-row lp-mint" />
          </span>
          <span className="lp-page lp-tinted">
            <i className="lp-line wide" />
            <i className="lp-line" />
          </span>
        </>
      )}
    </span>
  );
}
