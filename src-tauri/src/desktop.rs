//! Shows a note's file or a notes folder in the system's file manager. Modeled on Hangar's
//! `desktop.rs` (MIT, same owner): the paths come from the notes store only, never from the
//! window, and the programs start as an argv array without a shell.
//!
//! Windows: `explorer.exe` parses its command line itself and does not understand the C runtime
//! quoting of a whole argument, so its one argument is passed raw: `/select,"<file>"` or
//! `"<folder>"`. A Windows path cannot contain `"`, so the quotes cannot be broken out of.
//! (Hangar opens folders through `ShellExecuteExW`; that needs `windows-sys`, which this app does
//! not use, and for its own notes folders the raw argument is enough.)

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Program and arguments that show `file` selected (Linux: its folder opens).
pub fn reveal_command(file: &Path) -> (PathBuf, Vec<OsString>) {
    #[cfg(windows)]
    {
        let mut arg = OsString::from("/select,\"");
        arg.push(file.as_os_str());
        arg.push("\"");
        (explorer(), vec![arg])
    }
    #[cfg(target_os = "macos")]
    {
        (
            PathBuf::from("/usr/bin/open"),
            vec!["-R".into(), file.as_os_str().to_owned()],
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        folder_command(file.parent().unwrap_or(file))
    }
}

/// Program and arguments that open `folder`.
pub fn folder_command(folder: &Path) -> (PathBuf, Vec<OsString>) {
    #[cfg(windows)]
    {
        let mut arg = OsString::from("\"");
        arg.push(folder.as_os_str());
        arg.push("\"");
        (explorer(), vec![arg])
    }
    #[cfg(target_os = "macos")]
    {
        (
            PathBuf::from("/usr/bin/open"),
            vec![folder.as_os_str().to_owned()],
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        (
            PathBuf::from("xdg-open"),
            vec![folder.as_os_str().to_owned()],
        )
    }
}

#[cfg(windows)]
fn explorer() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("explorer.exe")
}

fn spawn((program, args): (PathBuf, Vec<OsString>)) -> io::Result<()> {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for arg in &args {
            command.raw_arg(arg);
        }
    }
    #[cfg(not(windows))]
    command.args(args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

pub fn reveal(file: &Path) -> io::Result<()> {
    spawn(reveal_command(file))
}

pub fn open_folder(folder: &Path) -> io::Result<()> {
    spawn(folder_command(folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_manager_gets_one_quoted_argument() {
        if cfg!(windows) {
            let (program, args) = reveal_command(Path::new(r"C:\Users\A B\n,1.md"));
            assert!(program.ends_with("explorer.exe"));
            assert_eq!(args, [OsString::from(r#"/select,"C:\Users\A B\n,1.md""#)]);
            let (_, args) = folder_command(Path::new(r"C:\x y"));
            assert_eq!(args, [OsString::from(r#""C:\x y""#)]);
        } else {
            let (_, args) = folder_command(Path::new("/a b"));
            assert_eq!(args, [OsString::from("/a b")]);
        }
    }
}
