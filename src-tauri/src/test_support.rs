//! Helpers shared by unit tests. Test files live under `<repo>/tests/.tmp/` (git-ignored), never
//! in the system temp folder.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// `<repo>/tests/.tmp`, the one place test files go.
pub fn tmp_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap_or(manifest)
        .join("tests")
        .join(".tmp")
}

/// A fresh, empty folder under [`tmp_root`], removed again on drop. Process id and counter keep
/// parallel tests and parallel runs apart even when two tests pick the same name.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir = tmp_root().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A link to a folder that needs no rights to create: a junction on Windows (`mklink /J`), a
/// symbolic link on Unix. `false` where the platform refused.
pub fn make_dir_link(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Calls that put files into the system temp folder, assembled with `concat!` so that this
    /// file does not match its own pattern.
    const FORBIDDEN: [&str; 2] = [concat!("env::", "temp_dir"), concat!("tempfile", "::")];

    #[test]
    fn nothing_writes_to_the_system_temp_folder() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut hits = Vec::new();
        for entry in fs::read_dir(&src).unwrap().flatten() {
            let text = fs::read_to_string(entry.path()).unwrap_or_default();
            for line in text.lines() {
                if !line.trim_start().starts_with("//")
                    && FORBIDDEN.iter().any(|p| line.contains(p))
                {
                    hits.push(format!("{}: {line}", entry.path().display()));
                }
            }
        }
        assert!(hits.is_empty(), "{hits:#?}");
        assert!(tmp_root().ends_with(Path::new("tests").join(".tmp")));
    }
}
