//! Windows only: files only their owner may open, and a listening socket no other one may share
//! (security review of phase 1, findings N1 and H3).
//!
//! - [`create_owner_only`] creates a file with an explicit, protected DACL that grants full access
//!   to the current user and SYSTEM and nothing else (SDDL `D:P(A;;FA;;;SY)(A;;FA;;;<user SID>)`).
//!   "Protected" means no ACE is inherited from the folder, so a folder whose ACL a program or an
//!   administrator widened never widens this file. A rename within the same volume keeps the
//!   descriptor, so the atomic write's temporary file passes it on to `endpoint.json`.
//! - [`set_exclusive_address`] sets `SO_EXCLUSIVEADDRUSE` on a socket before it is bound, so no
//!   other socket can bind the same address while it is held, not even one with `SO_REUSEADDR`
//!   (Microsoft's documentation on `SO_EXCLUSIVEADDRUSE`).

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawSocket, FromRawHandle as _};
use std::path::Path;

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Networking::WinSock::{
    setsockopt, SOCKET_ERROR, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// Closes a handle when dropped.
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful OpenProcessToken and is closed only here.
        unsafe { CloseHandle(self.0) };
    }
}

/// Frees memory the system allocated with `LocalAlloc` when dropped.
struct Local(*mut core::ffi::c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a system call documented to allocate it with
            // LocalAlloc, and it is freed only here.
            unsafe { LocalFree(self.0) };
        }
    }
}

/// The SID of the user this process runs as, in its string form (`S-1-5-21-...`).
pub fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing; `token` is a valid
    // out pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Handle(token);
    let mut needed = 0u32;
    // SAFETY: asking for the size only, with no buffer; fails with ERROR_INSUFFICIENT_BUFFER.
    unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64 elements keep the buffer aligned for TOKEN_USER, which holds a pointer.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: the buffer holds at least `needed` bytes and lives until the SID is converted.
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation(TokenUser) filled the aligned buffer with a TOKEN_USER.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: the SID points into `buffer`, which is still alive; `text` is a valid out pointer.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let text = Local(text.cast());
    // SAFETY: the system returned a NUL-terminated UTF-16 string.
    let units = unsafe {
        let start = text.0.cast::<u16>();
        let len = (0..).take_while(|&i| *start.add(i) != 0).count();
        std::slice::from_raw_parts(start, len)
    };
    Ok(String::from_utf16_lossy(units))
}

/// The descriptor of an owner-only file: protected, full access for SYSTEM and `sid`.
pub fn owner_only_sddl(sid: &str) -> String {
    format!("D:P(A;;FA;;;SY)(A;;FA;;;{sid})")
}

/// Creates `path` (it must not exist) for writing with the owner-only DACL.
pub fn create_owner_only(path: &Path) -> io::Result<File> {
    let sddl = wide(OsStr::new(&owner_only_sddl(&current_user_sid()?)));
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated and outlives the call; `descriptor` is a valid out pointer.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let descriptor = Local(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(u32::MAX),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let name = wide(path.as_os_str());
    // SAFETY: `name` is NUL-terminated, `attributes` and the descriptor it points to outlive the
    // call. Share mode 0: nobody else opens the file while it is written.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a valid file handle that nothing else owns.
    Ok(unsafe { File::from_raw_handle(handle) })
}

/// Sets `SO_EXCLUSIVEADDRUSE` on a socket that is not bound yet.
pub fn set_exclusive_address(socket: &impl AsRawSocket) -> io::Result<()> {
    let on: i32 = 1;
    // SAFETY: the socket is open for the call; the option value is a valid i32 of the given size.
    let result = unsafe {
        setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&on as *const i32).cast(),
            std::mem::size_of::<i32>() as i32,
        )
    };
    if result == SOCKET_ERROR {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The DACL of `path` in SDDL, for tests and diagnostics.
pub fn dacl_sddl(path: &Path) -> io::Result<String> {
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    let name = wide(path.as_os_str());
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `name` is NUL-terminated; only the descriptor is asked for, the other out pointers
    // may be null.
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let descriptor = Local(descriptor);
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: the descriptor came from GetNamedSecurityInfoW and is still alive.
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.0,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let text = Local(text.cast());
    // SAFETY: the system returned a NUL-terminated UTF-16 string.
    let units = unsafe {
        let start = text.0.cast::<u16>();
        let len = (0..).take_while(|&i| *start.add(i) != 0).count();
        std::slice::from_raw_parts(start, len)
    };
    Ok(String::from_utf16_lossy(units))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::io::Write as _;

    #[test]
    fn owner_only_files_grant_nobody_else_anything() {
        let dir = TempDir::new("winsec-dacl");
        let path = dir.path().join("secret file.json");
        let mut file = create_owner_only(&path).unwrap();
        file.write_all(b"{}").unwrap();
        drop(file);
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        let sddl = dacl_sddl(&path).unwrap();
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        // Protected: nothing inherited from the folder.
        assert!(sddl.starts_with("D:P"), "{sddl}");
        // Users, Everyone, Authenticated Users, by alias and by SID.
        for foreign in [
            ";;;BU)",
            ";;;WD)",
            ";;;AU)",
            "S-1-5-32-545",
            "S-1-1-0",
            "S-1-5-11",
        ] {
            assert!(!sddl.contains(foreign), "{foreign} in {sddl}");
        }
        // Exactly two entries: SYSTEM and this user.
        assert_eq!(sddl.matches("(A;").count(), 2, "{sddl}");
        assert!(sddl.contains(";;;SY)"), "{sddl}");
        assert!(sddl.contains(&format!(";;;{sid})")), "{sddl}");
        // An existing file is never opened again with this call.
        assert!(create_owner_only(&path).is_err());
    }
}
