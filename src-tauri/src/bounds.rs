//! Placing note windows onto visible monitors (ADR 0001). Pure: monitors come in as work areas in
//! logical pixels, so every case is testable without a screen.
//!
//! A remembered place is kept while the window's header, its drag region, can still be grabbed on
//! some monitor. Otherwise (a monitor was unplugged, the resolution shrank) the window moves onto
//! the primary monitor, as close to where it was as fits.

use crate::meta::{Bounds, MAX_SIDE};

pub const DEFAULT_WIDTH: f64 = 320.0;
pub const DEFAULT_HEIGHT: f64 = 320.0;
pub const MIN_WIDTH: f64 = 200.0;
pub const MIN_HEIGHT: f64 = 160.0;
/// How far a new note sits from the note it was created from.
pub const CASCADE_STEP: f64 = 32.0;
/// Height of the header strip that must stay reachable.
const GRIP_HEIGHT: f64 = 32.0;
/// How much of that strip must lie on one monitor to grab it with the mouse.
const MIN_VISIBLE_WIDTH: f64 = 48.0;
const MIN_VISIBLE_HEIGHT: f64 = 16.0;

/// A monitor's work area (without the taskbar) in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where a window opens: its size, and its position or `None` to let the system choose.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub width: f64,
    pub height: f64,
    pub position: Option<(f64, f64)>,
}

impl Placement {
    pub fn bounds(&self) -> Option<Bounds> {
        self.position.map(|(x, y)| Bounds {
            x,
            y,
            width: self.width,
            height: self.height,
        })
    }
}

fn overlap(a_start: f64, a_len: f64, b_start: f64, b_len: f64) -> f64 {
    ((a_start + a_len).min(b_start + b_len) - a_start.max(b_start)).max(0.0)
}

/// Whether the header strip of a window at `b` can be grabbed on one of the monitors.
pub fn is_reachable(b: &Bounds, monitors: &[Area]) -> bool {
    let need_width = MIN_VISIBLE_WIDTH.min(b.width);
    let grip = GRIP_HEIGHT.min(b.height);
    monitors.iter().any(|m| {
        overlap(b.x, b.width, m.x, m.width) >= need_width
            && overlap(b.y, grip, m.y, m.height) >= MIN_VISIBLE_HEIGHT.min(grip)
    })
}

fn clamp_size(width: f64, height: f64) -> (f64, f64) {
    (
        width.clamp(MIN_WIDTH, MAX_SIDE),
        height.clamp(MIN_HEIGHT, MAX_SIDE),
    )
}

/// `value` moved into `[start, start + room - len]`, or to `start` when it does not fit.
fn clamp_into(value: f64, len: f64, start: f64, room: f64) -> f64 {
    let end = start + (room - len).max(0.0);
    value.clamp(start, end)
}

/// The place for a window remembered at `bounds`.
pub fn place(bounds: Option<Bounds>, monitors: &[Area], primary: Option<Area>) -> Placement {
    let Some(b) = bounds.filter(Bounds::plausible) else {
        return Placement {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            position: None,
        };
    };
    let (width, height) = clamp_size(b.width, b.height);
    let sized = Bounds { width, height, ..b };
    if is_reachable(&sized, monitors) {
        return Placement {
            width,
            height,
            position: Some((b.x, b.y)),
        };
    }
    let Some(area) = primary.or_else(|| monitors.first().copied()) else {
        return Placement {
            width,
            height,
            position: None,
        };
    };
    let width = width.min(area.width).max(MIN_WIDTH);
    let height = height.min(area.height).max(MIN_HEIGHT);
    Placement {
        width,
        height,
        position: Some((
            clamp_into(b.x, width, area.x, area.width),
            clamp_into(b.y, height, area.y, area.height),
        )),
    }
}

/// The place of a note created from the note at `from`: one step down and to the right, back to
/// the top left of that monitor when the step would leave it.
pub fn cascade(from: Bounds, monitors: &[Area]) -> Bounds {
    let next = Bounds {
        x: from.x + CASCADE_STEP,
        y: from.y + CASCADE_STEP,
        ..from
    };
    let home = monitors.iter().find(|m| {
        overlap(from.x, from.width, m.x, m.width) > 0.0
            && overlap(from.y, from.height, m.y, m.height) > 0.0
    });
    match home {
        Some(m) if next.x + next.width > m.x + m.width || next.y + next.height > m.y + m.height => {
            Bounds {
                x: m.x + CASCADE_STEP,
                y: m.y + CASCADE_STEP,
                ..from
            }
        }
        _ => next,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Area = Area {
        x: -1920.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };
    const PRIMARY: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 2560.0,
        height: 1400.0,
    };

    fn at(x: f64, y: f64) -> Bounds {
        Bounds {
            x,
            y,
            width: 320.0,
            height: 300.0,
        }
    }

    #[test]
    fn without_a_remembered_place_the_system_chooses() {
        let placement = place(None, &[PRIMARY], Some(PRIMARY));
        assert_eq!(
            placement,
            Placement {
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
                position: None
            }
        );
        let garbage = Bounds {
            width: f64::INFINITY,
            ..at(0.0, 0.0)
        };
        assert_eq!(
            place(Some(garbage), &[PRIMARY], Some(PRIMARY)).position,
            None
        );
    }

    #[test]
    fn a_place_on_any_monitor_is_kept() {
        let on_left = at(-1500.0, 200.0);
        let placement = place(Some(on_left), &[LEFT, PRIMARY], Some(PRIMARY));
        assert_eq!(placement.bounds(), Some(on_left));
        // Partly off screen, but the header can still be grabbed.
        let hanging = at(2400.0, 1300.0);
        assert_eq!(
            place(Some(hanging), &[PRIMARY], Some(PRIMARY)).bounds(),
            Some(hanging)
        );
    }

    #[test]
    fn a_place_on_an_unplugged_monitor_moves_onto_the_primary_one() {
        let on_left = at(-1500.0, 200.0);
        let placement = place(Some(on_left), &[PRIMARY], Some(PRIMARY));
        assert_eq!(placement.position, Some((0.0, 200.0)));
        assert_eq!((placement.width, placement.height), (320.0, 300.0));
        let below = at(500.0, 5000.0);
        let placement = place(Some(below), &[PRIMARY], Some(PRIMARY));
        assert_eq!(placement.position, Some((500.0, 1100.0)));
    }

    #[test]
    fn a_header_above_the_screen_is_not_reachable() {
        // The window's body is visible, its header (the only drag region) is not.
        let above = at(100.0, -290.0);
        assert!(!is_reachable(&above, &[PRIMARY]));
        let placement = place(Some(above), &[PRIMARY], Some(PRIMARY));
        assert_eq!(placement.position, Some((100.0, 0.0)));
        // A sliver of a few pixels does not count either.
        assert!(!is_reachable(&at(2550.0, 10.0), &[PRIMARY]));
    }

    #[test]
    fn sizes_are_clamped_to_the_minimum_and_to_the_target_monitor() {
        let tiny = Bounds {
            width: 10.0,
            height: 10.0,
            ..at(100.0, 100.0)
        };
        let placement = place(Some(tiny), &[PRIMARY], Some(PRIMARY));
        assert_eq!((placement.width, placement.height), (MIN_WIDTH, MIN_HEIGHT));
        let huge = Bounds {
            x: -5000.0,
            y: 0.0,
            width: 4000.0,
            height: 3000.0,
        };
        let small = Area {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height: 680.0,
        };
        let placement = place(Some(huge), &[small], Some(small));
        assert_eq!(placement.position, Some((0.0, 0.0)));
        assert_eq!((placement.width, placement.height), (1280.0, 680.0));
    }

    #[test]
    fn without_any_monitor_the_size_stays_and_the_system_places() {
        let placement = place(Some(at(-1500.0, 200.0)), &[], None);
        assert_eq!(placement.position, None);
        assert_eq!((placement.width, placement.height), (320.0, 300.0));
    }

    #[test]
    fn new_notes_cascade_and_wrap_at_the_monitor_edge() {
        let next = cascade(at(100.0, 100.0), &[PRIMARY]);
        assert_eq!((next.x, next.y), (132.0, 132.0));
        let wrapped = cascade(at(2240.0, 1100.0), &[PRIMARY]);
        assert_eq!((wrapped.x, wrapped.y), (CASCADE_STEP, CASCADE_STEP));
        let on_left = cascade(at(-330.0, 100.0), &[LEFT, PRIMARY]);
        assert_eq!(
            (on_left.x, on_left.y),
            (-1920.0 + CASCADE_STEP, CASCADE_STEP)
        );
    }
}
