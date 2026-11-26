//! `install.json` (ADR 0002, "Detection and start"): written into Hangar Note's local data folder
//! on every start, so Hangar finds the app on every platform without a registry. Hangar reads it
//! by the known identifier `com.feoren.hangar-note` and checks that `exe` exists.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::fsio::write_atomic;

pub const INSTALL_FILE: &str = "install.json";
pub const INSTALL_VERSION: u32 = 1;
/// The contract version of the local channel and the command line this build speaks.
pub const CONTRACT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub version: u32,
    pub contract: u32,
    pub exe: PathBuf,
    pub app_version: String,
}

impl Install {
    pub fn current(exe: PathBuf) -> Self {
        Self {
            version: INSTALL_VERSION,
            contract: CONTRACT,
            exe,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

/// Writes `install.json` into `dir` atomically.
pub fn write(dir: &Path, install: &Install) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(install).map_err(io::Error::other)?;
    write_atomic(&dir.join(INSTALL_FILE), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn install_json_has_the_documented_shape() {
        let dir = TempDir::new("install");
        let exe = dir.path().join("hangar-note.exe");
        write(dir.path(), &Install::current(exe.clone())).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(INSTALL_FILE)).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 1,
                "contract": 1,
                "exe": exe,
                "appVersion": env!("CARGO_PKG_VERSION"),
            })
        );
    }
}
