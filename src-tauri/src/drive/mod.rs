//! Hangar Note's side of the sync through Hangar Drive (ADR 0006; contract "drive-local 1",
//! Hangar Drive repository, ADR 0003): finding Drive, asking it once to sync Hangar's notes
//! folder, and showing per note whether Drive has synced it.
//!
//! - `discovery`: Drive's `install.json` and `endpoint.json`, read with hard limits.
//! - `client`: the proven loopback exchange with the label `hangar-drive-local-server`, the
//!   routes `status`, `folders/request`, `items/status` and `events`.
//! - `paths`: the path rule every path of a request and an answer follows.
//! - `state`: the connection and the phase as explicit types, and the view for the windows.
//! - `worker`: the background threads.
//!
//! Drive syncs exactly Hangar's notes folder in its place. With another notes root (the
//! development root of a debug build) the client never starts and the phase stays `absent`.
//! Nothing here ever sends a note's content or a path to sync: Drive computes the folder itself.

pub mod client;
pub mod discovery;
pub mod paths;
pub mod state;
pub mod worker;

#[cfg(test)]
mod tests;

pub use state::{DriveSyncView, Phase, Reason};
pub use worker::{Config, DriveSync, NoteSource, ViewSink};
