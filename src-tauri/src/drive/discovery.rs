//! Finding Hangar Drive ("drive-local 1", Hangar Drive repository, ADR 0003, section 1): its
//! `install.json` and `endpoint.json` in `dirs::data_local_dir()/com.feoren.hangar-drive/`.
//!
//! - No readable `install.json` that lists version 1 of the contract `drive-local`: Drive is
//!   absent (not installed, or a build that does not serve this contract).
//! - `install.json` but no valid `endpoint.json`: installed but not running. Drive writes
//!   `install.json` also while its server is off, so the two cases are told apart.
//! - Both files are read with a hard size cap and never through a link
//!   (`fsio::read_capped_wiped`), and every field is checked: the token is 64 lowercase hex digits, the port is not 0. Unknown
//!   fields are ignored, so a newer Drive may add some. Whether something on the port really is
//!   Drive is only known after its proof (`client.rs`).
//! - The token is held in `Zeroizing` and never shown by `Debug`.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::channel::proof::is_hex64;
use crate::fsio::read_capped_wiped;

/// Hangar Drive's identifier: its files live in `dirs::data_local_dir()/<identifier>`.
pub const DRIVE_IDENTIFIER: &str = "com.feoren.hangar-drive";
pub const INSTALL_FILE: &str = "install.json";
pub const ENDPOINT_FILE: &str = "endpoint.json";
/// The contract and the version this build speaks.
pub const CONTRACT: &str = "drive-local";
pub const CONTRACT_VERSION: u64 = 1;
const FILE_VERSION: u64 = 1;
/// Far above anything Drive writes; a larger file is not read at all.
pub const MAX_INSTALL_BYTES: usize = 16 * 1024;
pub const MAX_ENDPOINT_BYTES: usize = 4 * 1024;

/// Drive's local data folder, from the user's local data folder.
pub fn drive_dir(data_local: Option<PathBuf>) -> Option<PathBuf> {
    data_local.map(|base| base.join(DRIVE_IDENTIFIER))
}

/// Where Drive's server listens, by its `endpoint.json`. No `PartialEq`: comparing tokens is done
/// in constant time where needed (`channel::token_eq`), never by a derived `==`.
#[derive(Clone)]
pub struct Endpoint {
    pub port: u16,
    /// Wiped when dropped.
    pub token: Zeroizing<String>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// What a look into Drive's folder found.
#[derive(Debug, Clone)]
pub enum Found {
    /// Not installed, or a build without "drive-local 1".
    Absent,
    /// Installed, but no usable `endpoint.json`: the server is off.
    NotRunning,
    /// An endpoint to try; Drive runs only if it proves itself.
    Endpoint(Endpoint),
}

#[derive(Deserialize)]
struct InstallIn {
    version: u64,
    contracts: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct EndpointIn {
    version: u64,
    port: u64,
    token: String,
}

/// Whether `install.json` declares a build that serves "drive-local 1".
pub fn install_serves_contract(bytes: &[u8]) -> bool {
    let Ok(install) = serde_json::from_slice::<InstallIn>(bytes) else {
        return false;
    };
    install.version == FILE_VERSION
        && install
            .contracts
            .get(CONTRACT)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|versions| {
                versions
                    .iter()
                    .any(|version| version.as_u64() == Some(CONTRACT_VERSION))
            })
}

/// The endpoint of an `endpoint.json`, if every field holds.
pub fn parse_endpoint(bytes: &[u8]) -> Option<Endpoint> {
    let parsed: EndpointIn = serde_json::from_slice(bytes).ok()?;
    let token = Zeroizing::new(parsed.token);
    if parsed.version != FILE_VERSION || !is_hex64(&token) {
        return None;
    }
    let port = u16::try_from(parsed.port).ok().filter(|port| *port > 0)?;
    Some(Endpoint { port, token })
}

/// Reads a file of at most `max` bytes into a wiped buffer; `None` for a missing, unreadable,
/// linked or larger file.
fn read_small(path: &Path, max: usize) -> Option<Zeroizing<Vec<u8>>> {
    read_capped_wiped(path, max).ok().flatten()
}

/// Looks into Drive's folder `dir`.
pub fn discover(dir: &Path) -> Found {
    let Some(install) = read_small(&dir.join(INSTALL_FILE), MAX_INSTALL_BYTES) else {
        return Found::Absent;
    };
    if !install_serves_contract(&install) {
        return Found::Absent;
    }
    match read_small(&dir.join(ENDPOINT_FILE), MAX_ENDPOINT_BYTES)
        .as_deref()
        .and_then(|bytes| parse_endpoint(bytes))
    {
        Some(endpoint) => Found::Endpoint(endpoint),
        None => Found::NotRunning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn install(contracts: &str) -> String {
        format!(
            r#"{{"version":1,"contracts":{contracts},"exe":"C:\\x\\hangar-drive.exe","appVersion":"0.1.0-412"}}"#
        )
    }

    #[test]
    fn install_json_must_list_contract_version_one() {
        assert!(install_serves_contract(
            install(r#"{"drive-local":[1]}"#).as_bytes()
        ));
        assert!(install_serves_contract(
            install(r#"{"drive-local":[2,1],"other":"x"}"#).as_bytes()
        ));
        // Unknown fields are ignored.
        assert!(install_serves_contract(
            br#"{"version":1,"contracts":{"drive-local":[1]},"future":{"a":1}}"#
        ));
        for contracts in [
            r#"{"drive-local":[2]}"#,
            r#"{"drive-local":1}"#,
            r#"{"drive-local":["1"]}"#,
            r#"{"drive-local":[]}"#,
            r#"{"other":[1]}"#,
            r#"{}"#,
        ] {
            assert!(
                !install_serves_contract(install(contracts).as_bytes()),
                "{contracts}"
            );
        }
        assert!(!install_serves_contract(
            br#"{"version":2,"contracts":{"drive-local":[1]}}"#
        ));
        assert!(!install_serves_contract(
            br#"{"contracts":{"drive-local":[1]}}"#
        ));
        assert!(!install_serves_contract(b"not json"));
    }

    #[test]
    fn endpoint_json_fields_are_checked() {
        let good = format!(r#"{{"version":1,"port":51234,"pid":9876,"token":"{TOKEN}"}}"#);
        let endpoint = parse_endpoint(good.as_bytes()).unwrap();
        assert_eq!(endpoint.port, 51234);
        assert_eq!(endpoint.token.as_str(), TOKEN);
        // Unknown fields and a missing pid are fine.
        let extra = format!(r#"{{"version":1,"port":1,"token":"{TOKEN}","later":true}}"#);
        assert_eq!(parse_endpoint(extra.as_bytes()).unwrap().port, 1);
        for bad in [
            format!(r#"{{"version":1,"port":0,"token":"{TOKEN}"}}"#),
            format!(r#"{{"version":1,"port":65536,"token":"{TOKEN}"}}"#),
            format!(r#"{{"version":1,"port":-1,"token":"{TOKEN}"}}"#),
            format!(r#"{{"version":2,"port":1,"token":"{TOKEN}"}}"#),
            format!(
                r#"{{"version":1,"port":1,"token":"{}"}}"#,
                TOKEN.to_uppercase()
            ),
            format!(r#"{{"version":1,"port":1,"token":"{}"}}"#, &TOKEN[1..]),
            format!(r#"{{"version":1,"port":1,"token":"{TOKEN}0"}}"#),
            format!(r#"{{"version":1,"port":1,"token":"{}"}}"#, "g".repeat(64)),
            r#"{"version":1,"port":1}"#.to_owned(),
            "[]".to_owned(),
        ] {
            assert!(parse_endpoint(bad.as_bytes()).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_endpoint_never_shows_its_token() {
        let good = format!(r#"{{"version":1,"port":5,"token":"{TOKEN}"}}"#);
        let endpoint = parse_endpoint(good.as_bytes()).unwrap();
        let shown = format!("{endpoint:?} {:?}", Found::Endpoint(endpoint.clone()));
        assert!(!shown.contains(TOKEN), "{shown}");
        assert!(shown.contains("port: 5"), "{shown}");
    }

    #[test]
    fn installed_but_not_running_is_told_apart() {
        let dir = TempDir::new("drive-discovery");
        assert!(matches!(discover(dir.path()), Found::Absent));
        assert!(matches!(
            discover(&dir.path().join("missing")),
            Found::Absent
        ));

        fs::write(
            dir.path().join(INSTALL_FILE),
            install(r#"{"drive-local":[2]}"#),
        )
        .unwrap();
        assert!(matches!(discover(dir.path()), Found::Absent));

        fs::write(
            dir.path().join(INSTALL_FILE),
            install(r#"{"drive-local":[1]}"#),
        )
        .unwrap();
        assert!(matches!(discover(dir.path()), Found::NotRunning));

        fs::write(dir.path().join(ENDPOINT_FILE), "{broken").unwrap();
        assert!(matches!(discover(dir.path()), Found::NotRunning));

        let endpoint = format!(r#"{{"version":1,"port":4711,"pid":1,"token":"{TOKEN}"}}"#);
        fs::write(dir.path().join(ENDPOINT_FILE), &endpoint).unwrap();
        match discover(dir.path()) {
            Found::Endpoint(found) => assert_eq!(found.port, 4711),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn oversized_files_are_not_read() {
        let dir = TempDir::new("drive-discovery-limits");
        // Valid JSON padded with white space beyond the cap.
        let padded_install = format!(
            "{}{}",
            install(r#"{"drive-local":[1]}"#),
            " ".repeat(MAX_INSTALL_BYTES)
        );
        fs::write(dir.path().join(INSTALL_FILE), &padded_install).unwrap();
        assert!(matches!(discover(dir.path()), Found::Absent));

        let exact = install(r#"{"drive-local":[1]}"#);
        let exact = format!("{exact}{}", " ".repeat(MAX_INSTALL_BYTES - exact.len()));
        assert_eq!(exact.len(), MAX_INSTALL_BYTES);
        fs::write(dir.path().join(INSTALL_FILE), &exact).unwrap();
        assert!(matches!(discover(dir.path()), Found::NotRunning));

        let endpoint = format!(r#"{{"version":1,"port":4711,"token":"{TOKEN}"}}"#);
        let padded = format!("{endpoint}{}", " ".repeat(MAX_ENDPOINT_BYTES));
        fs::write(dir.path().join(ENDPOINT_FILE), padded).unwrap();
        assert!(matches!(discover(dir.path()), Found::NotRunning));
    }

    #[test]
    fn the_folder_is_drives_identifier_under_local_data() {
        let base = PathBuf::from("base");
        assert_eq!(
            drive_dir(Some(base.clone())),
            Some(base.join("com.feoren.hangar-drive"))
        );
        assert_eq!(drive_dir(None), None);
    }
}
