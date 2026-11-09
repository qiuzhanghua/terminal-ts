//! Which shell a new terminal session should run.
//!
//! `$SHELL` alone is the wrong answer. It names the shell the user was *given*
//! at login, not the one they are typing in, and a GUI launch can inherit a
//! value that has nothing to do with the account: macOS starts GUI apps with
//! `/bin/bash` even when the account's shell has long been zsh. Detection
//! therefore mirrors qcode's `shell.rs`:
//!
//! ```text
//! configured shell > enclosing interactive shell > login shell > $SHELL > /bin/sh
//! ```
//!
//! The enclosing shell comes from walking the parent process chain; the login
//! shell from the user database (`getpwuid_r`, i.e. what `chsh` maintains).
//! Every layer is tolerant: a missing or non-executable path, or a parent that
//! cannot be read, is skipped instead of becoming an error, because a broken
//! detection must still open a terminal.

#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;

#[cfg(unix)]
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// Shells that count as "the user is working in this shell".
///
/// `sh` and `dash` are deliberately absent: scripts and every `#!/bin/sh`
/// launcher put one in the parent chain, so "nearest shell" would resolve to
/// dash for almost any program started from a script. Someone whose actual
/// login shell is dash is still caught by the login-shell layer.
#[cfg(unix)]
const INTERACTIVE_SHELLS: &[&str] = &[
    "bash", "zsh", "fish", "nu", "elvish", "xonsh", "tcsh", "csh", "ksh", "mksh", "oksh", "yash",
    "pwsh",
];

/// How far up the parent chain to look.
///
/// The chain from a GUI-launched process is short (shell → session manager →
/// systemd). The bound also stops a corrupted or recycled pid from turning the
/// walk into an infinite loop.
#[cfg(unix)]
const MAX_CHAIN_DEPTH: usize = 12;

/// Pick the shell a new session should run.
pub fn detect() -> PathBuf {
    #[cfg(windows)]
    {
        // There is no shell hierarchy to walk on Windows: probe for the shells
        // that exist, newest first.
        for name in ["pwsh", "powershell", "cmd"] {
            if which::which(name).is_ok() {
                return PathBuf::from(name);
            }
        }
        PathBuf::from("cmd")
    }

    #[cfg(unix)]
    {
        first_usable(
            enclosing_shell(&SystemProcesses, std::process::id())
                .into_iter()
                .chain(login_shell())
                .chain(env_shell()),
        )
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}

/// The first candidate that can actually be executed.
#[cfg(unix)]
fn first_usable(mut candidates: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.find(|path| is_executable(path))
}

/// `$SHELL`, the shell of whoever launched this process.
#[cfg(unix)]
fn env_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
}

/// The shell `chsh` wrote into the user database (`pw_shell`).
#[cfg(unix)]
fn login_shell() -> Option<PathBuf> {
    use std::ffi::CStr;

    // `getpwuid_r` is the thread-safe form. 4096 bytes is enough for a passwd
    // entry on every Unix this builds for (qcode uses the same size).
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = [0 as libc::c_char; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
        return None;
    }
    let shell = unsafe { CStr::from_ptr(pwd.pw_shell) }.to_string_lossy();
    if shell.is_empty() {
        None
    } else {
        Some(PathBuf::from(shell.into_owned()))
    }
}

/// The filesystem view the shell search needs.
///
/// A trait so the walk can be tested against invented process trees: wrapper
/// shells, cycles and vanished parents cannot be produced with real processes.
#[cfg(unix)]
trait ProcessTable {
    fn row(&self, pid: u32) -> Option<ProcessRow>;
}

#[cfg(unix)]
struct ProcessRow {
    ppid: u32,
    /// The executable path, when the OS will tell us. `None` is normal for
    /// another user's process.
    exe: Option<PathBuf>,
}

/// Walk up from `start` and return the first interactive shell.
#[cfg(unix)]
fn enclosing_shell(table: &dyn ProcessTable, start: u32) -> Option<PathBuf> {
    let mut pid = start;
    let mut visited = Vec::new();

    for _ in 0..MAX_CHAIN_DEPTH {
        if pid == 0 || visited.contains(&pid) {
            return None;
        }
        visited.push(pid);

        let row = table.row(pid)?;

        // A process whose executable cannot be read is skipped rather than
        // guessed at: guessing would mean running whatever happens to be first
        // on `PATH` under that name.
        if let Some(exe) = row
            .exe
            .as_deref()
            .map(clean_path)
            .filter(|path| is_executable(path))
        {
            if INTERACTIVE_SHELLS.contains(&basename(&exe).as_str()) {
                return Some(exe);
            }
        }

        pid = row.ppid;
    }

    None
}

/// Drop the suffix the OS appends to a path that is no longer there.
///
/// When a binary is replaced while running, Linux reports its link target as
/// `/usr/bin/zsh (deleted)`. The clean path is what gets checked, because the
/// shell may have been reinstalled at the same place.
#[cfg(unix)]
fn clean_path(path: &Path) -> PathBuf {
    let Some(name) = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return path.to_path_buf();
    };
    match name.strip_suffix(" (deleted)") {
        Some(stripped) => path.with_file_name(stripped),
        None => path.to_path_buf(),
    }
}

/// The file name without the directory, the ` (deleted)` suffix or a Windows
/// `.exe`.
#[cfg(unix)]
fn basename(path: &Path) -> String {
    let cleaned = clean_path(path);
    let mut name = cleaned
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let lowered = name.to_ascii_lowercase();
    if let Some(stripped) = lowered.strip_suffix(".exe") {
        name.truncate(stripped.len());
    }

    name
}

/// Whether the OS would let us execute this path.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// The real process table, read through `sysinfo`.
#[cfg(unix)]
struct SystemProcesses;

#[cfg(unix)]
impl ProcessTable for SystemProcesses {
    fn row(&self, pid: u32) -> Option<ProcessRow> {
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        // `refresh_processes(..)` on a fresh `System` only refreshes processes
        // it already knows about, so ask for this one pid explicitly. The
        // parent link comes along with the refresh; only `exe` is expensive
        // enough to request separately.
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            ProcessRefreshKind::new().with_exe(UpdateKind::Always),
        );
        let process = system.process(pid)?;
        Some(ProcessRow {
            ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
            exe: process.exe().map(Path::to_path_buf),
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeTable(HashMap<u32, ProcessRow>);

    impl ProcessTable for FakeTable {
        fn row(&self, pid: u32) -> Option<ProcessRow> {
            self.0.get(&pid).map(|row| ProcessRow {
                ppid: row.ppid,
                exe: row.exe.clone(),
            })
        }
    }

    fn table(rows: &[(u32, u32, Option<&str>)]) -> FakeTable {
        FakeTable(
            rows.iter()
                .map(|(pid, ppid, exe)| {
                    (
                        *pid,
                        ProcessRow {
                            ppid: *ppid,
                            exe: exe.map(PathBuf::from),
                        },
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn first_usable_skips_missing_paths() {
        let candidates = vec![
            PathBuf::from("/nonexistent/definitely-not-a-shell"),
            PathBuf::from("/bin/sh"),
        ];
        assert_eq!(
            first_usable(candidates.into_iter()),
            Some(PathBuf::from("/bin/sh"))
        );
    }

    #[test]
    fn enclosing_shell_finds_the_nearest_interactive_shell() {
        // self -> python3 -> sh -> zsh: the `sh` wrapper must not match, and
        // the walk must keep going to zsh.
        let table = table(&[
            (100, 101, Some("/usr/bin/python3")),
            (101, 102, Some("/bin/sh")),
            (102, 103, Some("/bin/zsh")),
        ]);
        assert_eq!(
            enclosing_shell(&table, 100),
            Some(PathBuf::from("/bin/zsh"))
        );
    }

    #[test]
    fn enclosing_shell_ignores_non_shell_processes() {
        let table = table(&[
            (100, 101, Some("/usr/bin/python3")),
            (101, 0, Some("/sbin/launchd")),
        ]);
        assert_eq!(enclosing_shell(&table, 100), None);
    }

    #[test]
    fn enclosing_shell_stops_at_cycles_and_missing_rows() {
        let cycle = table(&[(100, 101, Some("/usr/bin/python3")), (101, 100, None)]);
        assert_eq!(enclosing_shell(&cycle, 100), None);

        let missing = table(&[(100, 101, Some("/usr/bin/python3"))]);
        assert_eq!(enclosing_shell(&missing, 100), None);
    }

    #[test]
    fn enclosing_shell_does_not_guess_unreadable_executables() {
        // `comm` says zsh but the path is unknown: skip instead of resolving
        // through PATH, which could pick an unrelated zsh.
        let table = table(&[(100, 101, None), (101, 0, None)]);
        assert_eq!(enclosing_shell(&table, 100), None);
    }

    #[test]
    fn clean_path_strips_the_deleted_suffix() {
        assert_eq!(
            clean_path(Path::new("/usr/bin/zsh (deleted)")),
            PathBuf::from("/usr/bin/zsh")
        );
        assert_eq!(
            clean_path(Path::new("/usr/bin/zsh")),
            PathBuf::from("/usr/bin/zsh")
        );
    }

    #[test]
    fn basename_strips_directories_deleted_suffix_and_exe() {
        assert_eq!(basename(Path::new("/usr/bin/zsh")), "zsh");
        assert_eq!(basename(Path::new("/usr/bin/fish (deleted)")), "fish");
    }

    #[test]
    fn detect_returns_something_runnable() {
        // The exact answer depends on how the test was started; it must at
        // least be a path we could spawn.
        let shell = detect();
        assert!(!shell.as_os_str().is_empty());
        assert!(shell.is_absolute(), "detect() = {shell:?}");
        assert!(is_executable(&shell), "detect() = {shell:?}");
    }
}
