//! Asking note windows to save before something that would end them: deleting an open note from
//! the notes area and quitting from the tray (ADR 0001 anti-goal: never lose more than the last 500 ms
//! of typing). The text being typed lives only in the note's view, so the backend cannot save it
//! itself; it asks the view and waits for its answer, at most a timeout.
//!
//! No Tauri types: the asking is a closure, so the order (register, then ask, then wait) and the
//! decisions are testable without windows.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// What a note window answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteReply {
    /// Everything typed so far is on disk.
    Saved,
    /// The write failed: the text exists only in the window.
    NotSaved,
    /// The note saved and moved itself into the trash.
    Deleted,
}

/// The outcome of asking one note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asked {
    /// The note has no window, so nothing unsaved can exist.
    NoWindow,
    Answered(NoteReply),
    /// The window did not answer in time (still loading, or its view hangs).
    NoAnswer,
}

/// What deleting a note from "All notes" does after asking the note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteStep {
    /// The note deleted itself after saving.
    Done,
    /// The note could not save: deleting would throw its text away, so nothing is deleted.
    Refuse,
    /// Nothing unsaved is known: the backend deletes the note itself.
    DeleteHere,
}

pub fn delete_step(asked: Asked) -> DeleteStep {
    match asked {
        Asked::Answered(NoteReply::Deleted) => DeleteStep::Done,
        Asked::Answered(NoteReply::NotSaved) => DeleteStep::Refuse,
        // A window that never answers must not make a note undeletable; what it saved before is in
        // the trash.
        Asked::Answered(NoteReply::Saved) | Asked::NoWindow | Asked::NoAnswer => {
            DeleteStep::DeleteHere
        }
    }
}

/// What "Quit" does after asking every open note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitStep {
    Quit,
    /// These notes could not save; the app stays open and shows them.
    Stay(Vec<String>),
}

/// A "Quit" chosen again within this time after one that stayed open ends the app anyway, so a
/// note that can never save (folder gone, disk full) cannot trap the user in the app.
pub const QUIT_ANYWAY_WITHIN: Duration = Duration::from_secs(10);

/// `refused_at`: when the last "Quit" stayed open, if one did; `now`: when this "Quit" was chosen.
pub fn quit_step(
    results: Vec<(String, Asked)>,
    refused_at: Option<Instant>,
    now: Instant,
) -> QuitStep {
    let unsaved: Vec<String> = results
        .into_iter()
        .filter(|(_, asked)| *asked == Asked::Answered(NoteReply::NotSaved))
        .map(|(id, _)| id)
        .collect();
    // A hanging view does not keep the app from quitting: it would never end otherwise.
    let again = refused_at.is_some_and(|at| now.saturating_duration_since(at) < QUIT_ANYWAY_WITHIN);
    if unsaved.is_empty() || again {
        QuitStep::Quit
    } else {
        QuitStep::Stay(unsaved)
    }
}

/// When the last "Quit" stayed open, for [`quit_step`].
#[derive(Debug, Default)]
pub struct QuitMemory {
    refused_at: Mutex<Option<Instant>>,
}

impl QuitMemory {
    pub fn refused_at(&self) -> Option<Instant> {
        *self
            .refused_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn refused(&self, at: Instant) {
        *self
            .refused_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(at);
    }
}

type Waiters = HashMap<String, Vec<(u64, Sender<NoteReply>)>>;
/// A question that went out: its token and where the answer arrives.
type Waiting = (u64, Receiver<NoteReply>);

/// The questions waiting for an answer, per note ID.
#[derive(Debug, Default)]
pub struct Replies {
    state: Mutex<(u64, Waiters)>,
}

impl Replies {
    fn register(&self, id: &str) -> (u64, Receiver<NoteReply>) {
        let (sender, receiver) = mpsc::channel();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.0 += 1;
        let token = state.0;
        state
            .1
            .entry(id.to_owned())
            .or_default()
            .push((token, sender));
        (token, receiver)
    }

    fn forget(&self, id: &str, token: u64) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(list) = state.1.get_mut(id) {
            list.retain(|(own, _)| *own != token);
            if list.is_empty() {
                state.1.remove(id);
            }
        }
    }

    /// Hands `reply` to everyone waiting for note `id`; returns how many were waiting. An answer
    /// nobody asked for (the note's own "Delete" menu item) is dropped.
    pub fn answer(&self, id: &str, reply: NoteReply) -> usize {
        let waiting = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.1.remove(id).unwrap_or_default()
        };
        waiting
            .into_iter()
            .filter(|(_, sender)| sender.send(reply.clone()).is_ok())
            .count()
    }

    /// Asks one note: see [`Replies::ask_all`].
    pub fn ask(&self, id: &str, ask: impl FnOnce(&str) -> bool, timeout: Duration) -> Asked {
        let mut ask = Some(ask);
        let ids = [id.to_owned()];
        self.ask_all(&ids, |id| ask.take().is_some_and(|ask| ask(id)), timeout)
            .pop()
            .map_or(Asked::NoAnswer, |(_, asked)| asked)
    }

    /// Asks every note in `ids` through `ask` (which sends the event and returns `false` when the
    /// note has no window) and waits for all answers, together at most `timeout`. Each note is
    /// registered before it is asked, so an answer that comes back at once is never lost.
    pub fn ask_all(
        &self,
        ids: &[String],
        mut ask: impl FnMut(&str) -> bool,
        timeout: Duration,
    ) -> Vec<(String, Asked)> {
        let deadline = Instant::now() + timeout;
        let asked: Vec<(String, Option<Waiting>)> = ids
            .iter()
            .map(|id| {
                let (token, receiver) = self.register(id);
                if ask(id) {
                    (id.clone(), Some((token, receiver)))
                } else {
                    self.forget(id, token);
                    (id.clone(), None)
                }
            })
            .collect();
        asked
            .into_iter()
            .map(|(id, waiting)| {
                let Some((token, receiver)) = waiting else {
                    return (id, Asked::NoWindow);
                };
                let left = deadline.saturating_duration_since(Instant::now());
                let result = match receiver.recv_timeout(left) {
                    Ok(reply) => Asked::Answered(reply),
                    Err(_) => Asked::NoAnswer,
                };
                self.forget(&id, token);
                (id, result)
            })
            .collect()
    }

    #[cfg(test)]
    fn waiting(&self) -> usize {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.1.values().map(Vec::len).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const SHORT: Duration = Duration::from_millis(50);
    const LONG: Duration = Duration::from_secs(5);

    #[test]
    fn an_answer_given_while_being_asked_is_not_lost() {
        // The note may answer before `ask` even returns; registering first keeps that answer.
        let replies = Replies::default();
        let asked = replies.ask(
            "a",
            |id| {
                assert_eq!(replies.answer(id, NoteReply::Saved), 1);
                true
            },
            SHORT,
        );
        assert_eq!(asked, Asked::Answered(NoteReply::Saved));
        assert_eq!(replies.waiting(), 0);
    }

    #[test]
    fn the_wait_ends_with_the_answer_from_another_thread() {
        let replies = Arc::new(Replies::default());
        let note = {
            let replies = replies.clone();
            std::thread::spawn(move || {
                // The note saves, then deletes itself and reports its trash entry.
                while replies.answer("a", NoteReply::Deleted) == 0 {
                    std::thread::sleep(Duration::from_millis(5));
                }
            })
        };
        let started = Instant::now();
        let asked = replies.ask("a", |_| true, LONG);
        note.join().unwrap();
        assert_eq!(asked, Asked::Answered(NoteReply::Deleted));
        assert!(started.elapsed() < LONG);
    }

    #[test]
    fn a_note_without_a_window_is_not_waited_for() {
        let replies = Replies::default();
        let started = Instant::now();
        assert_eq!(replies.ask("a", |_| false, LONG), Asked::NoWindow);
        assert!(started.elapsed() < LONG);
        assert_eq!(replies.waiting(), 0);
    }

    #[test]
    fn a_silent_note_times_out_and_leaves_nothing_behind() {
        let replies = Replies::default();
        assert_eq!(replies.ask("a", |_| true, SHORT), Asked::NoAnswer);
        assert_eq!(replies.waiting(), 0);
        // A late answer reaches nobody.
        assert_eq!(replies.answer("a", NoteReply::Saved), 0);
    }

    #[test]
    fn asking_all_shares_one_deadline_and_keeps_the_order() {
        let replies = Replies::default();
        let ids: Vec<String> = ["a", "b", "c"].map(String::from).into();
        let started = Instant::now();
        let results = replies.ask_all(
            &ids,
            |id| match id {
                "a" => {
                    replies.answer(id, NoteReply::Saved);
                    true
                }
                "b" => true,
                _ => false,
            },
            Duration::from_millis(200),
        );
        assert_eq!(
            results,
            vec![
                ("a".to_owned(), Asked::Answered(NoteReply::Saved)),
                ("b".to_owned(), Asked::NoAnswer),
                ("c".to_owned(), Asked::NoWindow),
            ]
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn deleting_goes_ahead_only_when_no_unsaved_text_is_known() {
        assert_eq!(
            delete_step(Asked::Answered(NoteReply::Deleted)),
            DeleteStep::Done
        );
        assert_eq!(
            delete_step(Asked::Answered(NoteReply::NotSaved)),
            DeleteStep::Refuse
        );
        assert_eq!(
            delete_step(Asked::Answered(NoteReply::Saved)),
            DeleteStep::DeleteHere
        );
        assert_eq!(delete_step(Asked::NoWindow), DeleteStep::DeleteHere);
        assert_eq!(delete_step(Asked::NoAnswer), DeleteStep::DeleteHere);
    }

    fn failed() -> Vec<(String, Asked)> {
        vec![
            ("a".to_owned(), Asked::Answered(NoteReply::NotSaved)),
            ("b".to_owned(), Asked::Answered(NoteReply::Saved)),
            ("c".to_owned(), Asked::Answered(NoteReply::NotSaved)),
        ]
    }

    #[test]
    fn quitting_stays_open_for_every_note_that_could_not_save() {
        let now = Instant::now();
        let all_fine = vec![
            ("a".to_owned(), Asked::Answered(NoteReply::Saved)),
            ("b".to_owned(), Asked::NoWindow),
            ("c".to_owned(), Asked::NoAnswer),
        ];
        assert_eq!(quit_step(all_fine, None, now), QuitStep::Quit);
        assert_eq!(quit_step(Vec::new(), None, now), QuitStep::Quit);
        assert_eq!(
            quit_step(failed(), None, now),
            QuitStep::Stay(vec!["a".to_owned(), "c".to_owned()])
        );
    }

    #[test]
    fn quitting_again_soon_after_staying_open_quits_anyway() {
        let refused = Instant::now();
        let soon = refused + QUIT_ANYWAY_WITHIN - Duration::from_millis(1);
        assert_eq!(quit_step(failed(), Some(refused), soon), QuitStep::Quit);
        // Later, it is a new attempt that stays open again.
        let late = refused + QUIT_ANYWAY_WITHIN;
        assert!(matches!(
            quit_step(failed(), Some(refused), late),
            QuitStep::Stay(_)
        ));
    }

    #[test]
    fn the_quit_memory_keeps_the_last_refusal() {
        let memory = QuitMemory::default();
        assert_eq!(memory.refused_at(), None);
        let first = Instant::now();
        memory.refused(first);
        let second = first + Duration::from_secs(20);
        memory.refused(second);
        assert_eq!(memory.refused_at(), Some(second));
    }
}
