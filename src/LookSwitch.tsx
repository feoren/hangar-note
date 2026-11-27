// The quick choice of the look (ADR 0004): two small icons at the top right of the notes, the
// same place in every look. A radio group with one Tab stop; the arrow keys, Home and End move the
// choice (shortcuts.ts). Choosing calls the same `chooseLook` as the settings and the app menu, so
// the open note, its unsaved text and its pending save stay. The new look draws its own switch;
// the focus, if it was on the old one, moves onto the new one.

import { useLayoutEffect, useRef } from "react";

import { HangarLookIcon, PaperLookIcon } from "./icons";
import { focusLookOnDraw, takeLookFocus } from "./lookFocus";
import { LOOK_NAMES, LOOKS, type Look } from "./looks";
import { radioTarget } from "./shortcuts";
import type { NotesModel } from "./useNotesArea";

const ICONS: Readonly<Record<Look, (props: { size?: number }) => React.ReactElement>> = {
  paper: PaperLookIcon,
  hangar: HangarLookIcon,
};

export function LookSwitch({ m }: { m: NotesModel }) {
  const { t, look } = m;
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    if (!takeLookFocus(look)) return;
    radios.current[LOOKS.indexOf(look)]?.focus();
  }, [look]);

  const choose = (next: Look) => {
    if (next === look) return;
    focusLookOnDraw(next);
    m.chooseLook(next);
  };

  return (
    <div className="look-switch" role="radiogroup" aria-label={t("settings.look")}>
      {LOOKS.map((each, index) => {
        const Icon = ICONS[each];
        const name = t(LOOK_NAMES[each]);
        const chosen = each === look;
        return (
          <button
            key={each}
            ref={(element) => {
              radios.current[index] = element;
            }}
            type="button"
            role="radio"
            className="look-option"
            data-look={each}
            aria-checked={chosen}
            aria-label={name}
            title={name}
            tabIndex={chosen ? 0 : -1}
            onClick={() => {
              choose(each);
            }}
            onKeyDown={(event) => {
              const rtl = document.documentElement.dir === "rtl";
              const target = radioTarget(event, index, LOOKS.length, rtl);
              const next = target === null ? undefined : LOOKS[target];
              if (target === null || next === undefined) return;
              event.preventDefault();
              radios.current[target]?.focus();
              choose(next);
            }}
          >
            <Icon size={16} />
          </button>
        );
      })}
    </div>
  );
}
