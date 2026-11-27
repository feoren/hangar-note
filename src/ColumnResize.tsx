// The right edge of a column whose width can be dragged (columnWidth.ts): the sidebar's and hangar's
// note list's. One element, role "separator", for the mouse, a pen and the keyboard.

import { useRef } from "react";

import { clampColumnWidth, separatorChange, type ColumnSpec } from "./columnWidth";

/**
 * Dragged with the mouse or a pen (pointer capture), moved with the arrow keys (Shift: a larger
 * step), Home and End; a double click or Enter gives the column its natural width back. The width
 * is shown while dragging (`onShow`) and stored only when the drag ends (`onStore`); a cancelled
 * drag shows the width from before it again (`onCancel`). Chrome delivers pointer moves once per frame, so a
 * drag renders no more often than the screen draws.
 */
export function ColumnResize({
  spec,
  className,
  label,
  hint,
  controls,
  width,
  room,
  onShow,
  onStore,
  onCancel,
  onReset,
}: {
  spec: ColumnSpec;
  className: string;
  label: string;
  hint: string;
  /** The id of the column this edge sizes. */
  controls: string;
  /** The width shown now, already within the range of `room`. */
  width: number;
  /** The room the column's range depends on (columnWidth.ts). */
  room: number;
  onShow: (width: number) => void;
  onStore: (width: number) => void;
  /** A drag that ended where it started, or was cancelled: the width from before it shows again. */
  onCancel: () => void;
  onReset: () => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const rtl = () => document.documentElement.dir === "rtl";

  const widthAt = (clientX: number) => {
    const start = drag.current;
    if (start === null) return width;
    const moved = rtl() ? start.startX - clientX : clientX - start.startX;
    return clampColumnWidth(spec, start.startWidth + moved, room);
  };

  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max(room)}
      tabIndex={0}
      title={hint}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, last: width };
        event.currentTarget.classList.add("dragging");
      }}
      onPointerMove={(event) => {
        if (drag.current === null) return;
        const next = widthAt(event.clientX);
        if (next === drag.current.last) return;
        drag.current.last = next;
        onShow(next);
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (start === null) return;
        drag.current = null;
        event.currentTarget.classList.remove("dragging");
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (start.last === start.startWidth) onCancel();
        else onStore(start.last);
      }}
      onPointerCancel={(event) => {
        const start = drag.current;
        drag.current = null;
        event.currentTarget.classList.remove("dragging");
        if (start !== null) onCancel();
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const change = separatorChange(spec, event, width, room, rtl());
        if (change === null) return;
        event.preventDefault();
        if (change.kind === "reset") onReset();
        else if (change.width !== width) onStore(change.width);
      }}
    />
  );
}
