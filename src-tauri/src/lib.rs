//! Tauri backend for the terminal emulator.
//!
//! Mirrors the shell-detection logic of the original `terminal` CLI project:
//! - Windows: pwsh -> powershell -> cmd
//! - Other: `$SHELL` env var, falling back to `/bin/bash`
//!
//! Each tab owns one real PTY session (ConPTY on Windows), streamed to the
//! frontend via `terminal-output` / `terminal-exit` events.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager, State, Window, WindowEvent};

/// Max bytes read from the pty per `terminal-output` event. Output is
/// base64-encoded, so larger chunks stay compact on the wire.
const READ_CHUNK: usize = 65536;

/// A live shell session backed by a PTY.
struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// `Arc` so `write_session` can drop the session-map lock before touching
    /// the pty: `write_all` blocks once the pty buffer fills, and holding the
    /// map lock across that would stall every other session operation.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Output produced before the frontend attached its listeners.
    buf: Arc<Mutex<SessionBuffer>>,
}

/// Startup output has to survive until the webview is listening.
///
/// `spawn_shell` returns as soon as the pty is running, but the frontend only
/// registers `terminal-output` at the end of `TerminalView`'s async mount —
/// by then the shell has already printed its prompt. Emitting into that gap
/// dropped the prompt, so the user saw an empty terminal until pressing Enter
/// made the shell redraw. Everything is buffered here until `attach_session`.
#[derive(Default)]
struct SessionBuffer {
    attached: bool,
    /// Raw bytes, not base64: each chunk is base64-encoded on its own, so
    /// concatenating encoded chunks would interleave `=` padding and produce
    /// a payload `atob` rejects.
    pending: Vec<u8>,
}

/// Upper bound for the pre-attach buffer. A healthy startup flushes this
/// within a second; the cap only matters if the frontend never attaches, in
/// which case the oldest output is dropped to keep memory bounded.
const MAX_PENDING: usize = 1 << 20;

impl SessionBuffer {
    fn push(&mut self, bytes: &[u8]) {
        if self.pending.len() + bytes.len() > MAX_PENDING {
            let cut = self.pending.len().saturating_sub(MAX_PENDING / 2);
            self.pending.drain(..cut);
        }
        self.pending.extend_from_slice(bytes);
    }
}

/// One process worth telling the user about.
#[derive(Clone, Debug, PartialEq, Serialize)]
struct ActivityProcess {
    pid: u32,
    name: String,
}

/// What a session is doing right now: a foreground job and/or long-lived
/// descendants. Empty fields mean the tab is idle.
#[derive(Clone, Debug, PartialEq, Serialize)]
struct SessionActivity {
    id: u64,
    foreground: Option<ActivityProcess>,
    background: Vec<ActivityProcess>,
}

/// Flat process snapshot, kept separate from `sysinfo` so the filtering logic
/// stays testable without touching the real process table.
#[derive(Clone, Debug, PartialEq)]
struct ProcInfo {
    pid: u32,
    ppid: Option<u32>,
    name: String,
    age_secs: u64,
}

/// BFS the children map. Leaves are not sorted; callers kill in reverse order.
fn collect_descendants(procs: &[ProcInfo], root: u32) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        for proc in procs {
            if proc.ppid == Some(parent) && !found.contains(&proc.pid) {
                found.push(proc.pid);
                stack.push(proc.pid);
            }
        }
    }
    found
}

/// Decide what to report for one session.
///
/// * `foreground` is the pty's foreground process group (Unix `tcgetpgrp`);
///   anything other than the shell itself is a foreground job.
/// * `background` is every descendant older than `min_age_secs` that is not
///   already the foreground job. The age threshold filters out prompt helpers
///   (oh-my-posh, git status) that come and go in milliseconds.
fn busy_activity(
    shell_pid: u32,
    foreground_pgid: Option<u32>,
    procs: &[ProcInfo],
    min_age_secs: u64,
    excluded_names: &[&str],
) -> (Option<ActivityProcess>, Vec<ActivityProcess>) {
    let fg_pid = foreground_pgid.filter(|pid| *pid != 0 && *pid != shell_pid);

    let foreground = fg_pid.map(|pid| {
        let name = procs
            .iter()
            .find(|proc| proc.pid == pid)
            .map(|proc| proc.name.clone())
            .unwrap_or_else(|| "?".to_string());
        ActivityProcess { pid, name }
    });

    let mut background: Vec<ActivityProcess> = collect_descendants(procs, shell_pid)
        .into_iter()
        .filter(|pid| Some(*pid) != fg_pid)
        .filter_map(|pid| procs.iter().find(|proc| proc.pid == pid).cloned())
        .filter(|proc| proc.age_secs >= min_age_secs)
        .filter(|proc| {
            !excluded_names
                .iter()
                .any(|excluded| proc.name.eq_ignore_ascii_case(excluded))
        })
        .map(|proc| ActivityProcess {
            pid: proc.pid,
            name: proc.name,
        })
        .collect();
    background.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
    background.truncate(5);

    (foreground, background)
}

/// Terminate a process tree: leaves first, SIGTERM, a short grace period,
/// then SIGKILL for whatever survived. Used when a tab is closed or the app
/// quits, so confirming "this ends the session" actually ends it.
fn kill_tree(root: u32) {
    let snapshot = || {
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All);
        let procs: Vec<ProcInfo> = system
            .processes()
            .iter()
            .map(|(pid, proc)| ProcInfo {
                pid: pid.as_u32(),
                ppid: proc.parent().map(|parent| parent.as_u32()),
                name: proc.name().to_string_lossy().to_string(),
                age_secs: proc.run_time(),
            })
            .collect();
        (system, procs)
    };

    let (system, procs) = snapshot();
    let mut victims = collect_descendants(&procs, root);
    victims.reverse();
    for pid in victims.iter().chain(std::iter::once(&root)) {
        if let Some(proc) = system.process(Pid::from_u32(*pid)) {
            #[cfg(unix)]
            let _ = proc.kill_with(sysinfo::Signal::Term);
            #[cfg(not(unix))]
            let _ = proc.kill();
        }
    }

    std::thread::sleep(Duration::from_millis(150));

    let (system, procs) = snapshot();
    let mut remaining = collect_descendants(&procs, root);
    remaining.reverse();
    for pid in remaining.iter().chain(std::iter::once(&root)) {
        if let Some(proc) = system.process(Pid::from_u32(*pid)) {
            let _ = proc.kill();
        }
    }
}

#[derive(Default)]
struct SessionManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Session>>,
}

#[derive(Clone, Serialize)]
struct OutputPayload {
    id: u64,
    /// Base64-encoded pty output (compact vs. JSON number[]).
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: u64,
    code: Option<u32>,
}

/// User configuration from `config.json` in the app config dir. All fields
/// have defaults; `shell` / `font_family` / `start_cwd` are `None` = auto.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
struct AppConfig {
    /// Override shell detection, e.g. "pwsh", "cmd", "bash".
    shell: Option<String>,
    /// Terminal font size in px.
    font_size: u16,
    /// Override the runtime-detected font chain, e.g. "JetBrainsMono NFM".
    font_family: Option<String>,
    /// Theme preset name, or "followSystem" to follow the OS dark/light mode.
    theme: String,
    cursor_blink: bool,
    scrollback: u32,
    /// Starting directory for new shells; `None` = user home.
    start_cwd: Option<String>,
    /// Warn before closing when a tab still has a running process.
    confirm_on_running_processes: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            shell: None,
            font_size: 20,
            font_family: None,
            theme: "dark".to_string(),
            cursor_blink: true,
            scrollback: 10000,
            start_cwd: None,
            confirm_on_running_processes: true,
        }
    }
}

#[derive(Clone, Serialize)]
struct ConfigPayload {
    config: AppConfig,
    /// Absolute path of the config file (empty if the config dir is unavailable).
    path: String,
}

/// `<app config dir>/config.json`, e.g. `%APPDATA%\dev.taiji.terminal`.
fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

/// Read the user config; creates a default file on first run.
fn load_config(app: &AppHandle) -> AppConfig {
    let Some(path) = config_path(app) else {
        return AppConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => {
            let defaults = AppConfig::default();
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_ok() {
                    if let Ok(json) = serde_json::to_string_pretty(&defaults) {
                        let _ = std::fs::write(&path, json);
                    }
                }
            }
            defaults
        }
    }
}

/// Same shell detection as the original `terminal` project.
fn detect_shell() -> String {
    #[cfg(windows)]
    {
        if which::which("pwsh").is_ok() {
            "pwsh".to_string()
        } else if which::which("powershell").is_ok() {
            "powershell".to_string()
        } else {
            "cmd".to_string()
        }
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Current working directory of the process `pid`, or `None` when it cannot be
/// read (process already gone, or the OS does not expose it for that process).
///
/// `sysinfo` is used because there is no portable std API for another process's
/// cwd: Linux reads `/proc/<pid>/cwd`, macOS asks `proc_pidinfo`, Windows reads
/// the PEB via `NtQueryInformationProcess`.
fn process_cwd(pid: u32) -> Option<PathBuf> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    // `refresh_processes(..)` would not work here: it only refreshes processes
    // already known to the (empty) `System`, so a fresh instance reports no cwd.
    // Ask for this one pid explicitly, and only for its cwd — a full refresh
    // would walk every process on the machine on each new tab.
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
    );
    system
        .process(pid)
        .and_then(|process| process.cwd())
        .map(Path::to_path_buf)
}

/// Pick the directory a fresh shell should start in.
///
/// Priority: `requested` (a new tab inheriting the active tab's cwd) beats
/// `configured` (`config.json`'s `start_cwd`), and both fall back to the user's
/// home directory. Entries that no longer exist are skipped, so a stale cwd
/// (directory deleted while the old tab sat in it) cannot be handed to
/// `spawn_command`, which would fail to start the shell at all.
fn resolve_start_cwd(requested: Option<&str>, configured: Option<&str>) -> Option<PathBuf> {
    requested
        .into_iter()
        .chain(configured)
        .map(PathBuf::from)
        .find(|path| path.is_dir())
        .or_else(dirs::home_dir)
}

/// Kill every session. Called from the window `Destroyed` handler, i.e. on the
/// GTK main thread, so it must never block: blocking there freezes the whole
/// UI (the close button appears dead).
///
/// The map lock is released before any child is touched. Nesting it with the
/// per-session child lock deadlocks against the exit watcher, which polls that
/// same child under its own lock.
fn kill_all_sessions(app: &AppHandle) {
    let drained: Vec<Session> = {
        let state = app.state::<SessionManager>();
        let mut sessions = state.sessions.lock().unwrap();
        sessions.drain().map(|(_, session)| session).collect()
    };
    for session in drained {
        let pid = session.child.lock().unwrap().process_id();
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        let _ = session.child.lock().unwrap().kill();
    }
}

/// Spawn a new shell session and return its id. The pty reader runs on a
/// background thread and forwards output to the frontend as events.
///
/// `cwd` is the directory the shell should start in; the frontend passes the
/// active tab's cwd so a new tab opens where the old one was. `None` falls back
/// to `config.json`'s `start_cwd`, then to the home directory.
#[tauri::command]
fn spawn_shell(
    app: AppHandle,
    window: Window,
    state: State<'_, SessionManager>,
    cwd: Option<String>,
) -> Result<u64, String> {
    let config = load_config(&app);
    // User-configured shell wins; fall back to detection if it's not on PATH.
    let shell = match &config.shell {
        Some(s) if which::which(s).is_ok() => s.clone(),
        _ => detect_shell(),
    };

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // portable-pty rebuilds the environment from the Windows registry, which
    // drops session-injected PATH entries (e.g. `cot\bin` added by `c`).
    // Re-apply the parent process's full PATH so the shell sees it too.
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    // Suppress pwsh startup noise: version banner, update notice and
    // profile-load-time message. Also force $PSStyle.OutputRendering='Ansi':
    // under ConPTY pwsh's first prompt is otherwise rendered without colors
    // ('Host' strips ANSI), which breaks oh-my-posh segments.
    if shell == "pwsh" {
        cmd.arg("-NoLogo");
        cmd.arg("-NoProfileLoadTime");
        cmd.arg("-NoExit");
        cmd.arg("-Command");
        cmd.arg("$PSStyle.OutputRendering='Ansi'");
        cmd.env("POWERSHELL_UPDATECHECK", "Off");
    } else if shell == "powershell" {
        cmd.arg("-NoLogo");
        cmd.env("POWERSHELL_UPDATECHECK", "Off");
    }
    // cwd priority: caller request (new tab inheriting the active tab) >
    // config.start_cwd > home dir.
    if let Some(start_cwd) = resolve_start_cwd(cwd.as_deref(), config.start_cwd.as_deref()) {
        cmd.cwd(start_cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn `{shell}`: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let child_shared = Arc::new(Mutex::new(child));
    let child_for_watcher = child_shared.clone();
    let buf = Arc::new(Mutex::new(SessionBuffer::default()));
    let buf_for_reader = buf.clone();

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child: child_shared.clone(),
            buf,
        },
    );

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut raw = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut raw) {
                Ok(0) => break,
                Ok(n) => {
                    // Decide under the buffer lock whether this chunk can go
                    // out now or has to wait for `attach_session`, and hold
                    // that lock across the emit so the buffered prefix is
                    // never overtaken by live output.
                    let mut live: Option<String> = None;
                    {
                        let mut b = buf_for_reader.lock().unwrap();
                        if b.attached {
                            live = Some(STANDARD.encode(&raw[..n]));
                        } else {
                            b.push(&raw[..n]);
                        }
                    }
                    if let Some(data) = live {
                        let payload = OutputPayload { id, data };
                        if window.emit("terminal-output", payload).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }

        // The pty closed: poll for the real exit code without blocking forever.
        // The guard is bound to a local so it is released before sleeping —
        // holding it across `sleep` (as a `match` temporary would) starves
        // every other thread that needs the child lock.
        let mut code: Option<u32> = None;
        for _ in 0..200 {
            let waited = { child_shared.lock().unwrap().try_wait() };
            match waited {
                Ok(Some(status)) => {
                    code = Some(status.exit_code());
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = window.emit("terminal-exit", ExitPayload { id, code });
    });

    // Watch for the child process exiting. Some ConPTY hosts do NOT deliver a
    // read-EOF when the client exits while the master handle is still open, so
    // the reader thread above would block forever and `terminal-exit` would
    // never fire. When the child exits we remove the session, which drops the
    // master and closes the ConPTY → the reader thread gets EOF and emits the
    // exit event with the real exit code.
    {
        let app_watcher = app.clone();
        let child_watcher = child_for_watcher;
        let id_watcher = id;
        std::thread::spawn(move || {
            loop {
                // Same rule as above: never hold the child lock while sleeping.
                let waited = { child_watcher.lock().unwrap().try_wait() };
                match waited {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    Err(_) => break,
                }
            }
            let manager = app_watcher.state::<SessionManager>();
            manager.sessions.lock().unwrap().remove(&id_watcher);
        });
    }

    Ok(id)
}

/// Hand the frontend everything the shell printed before it was listening.
///
/// The listener must already be registered when this is called: the buffered
/// bytes are emitted as a normal `terminal-output` event so they stay in the
/// same ordered channel as the live output that follows.
#[tauri::command]
fn attach_session(window: Window, state: State<'_, SessionManager>, id: u64) -> Result<(), String> {
    let buf = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).map(|session| session.buf.clone())
    };
    let Some(buf) = buf else {
        return Err(format!("no such session {id}"));
    };

    // Hold the buffer lock across the emit: the reader thread cannot slip a
    // live chunk in between, so order is preserved.
    let mut b = buf.lock().unwrap();
    b.attached = true;
    let pending = std::mem::take(&mut b.pending);
    // Encode once, after the chunks have been reassembled into one byte run.
    if !pending.is_empty() {
        let _ = window.emit(
            "terminal-output",
            OutputPayload {
                id,
                data: STANDARD.encode(&pending),
            },
        );
    }
    Ok(())
}

/// Current working directory of a session's shell.
///
/// Used to make a new tab open in the same directory as the tab that was active
/// when it was created. Returns `None` — rather than an error — when the cwd is
/// unreadable, so the frontend simply falls back to the default start dir.
#[tauri::command]
fn session_cwd(state: State<'_, SessionManager>, id: u64) -> Option<String> {
    // Same rule as the other session commands: take what is needed under the
    // map lock, release it, then do the work. The sysinfo lookup touches the
    // OS and must not run with the session map held.
    let child = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).map(|session| session.child.clone())
    }?;
    let pid = {
        let child = child.lock().unwrap();
        child.process_id()
    }?;
    process_cwd(pid).map(|path| path.display().to_string())
}

/// Write keystrokes from the frontend into the session's pty.
#[tauri::command]
fn write_session(state: State<'_, SessionManager>, id: u64, data: Vec<u8>) -> Result<(), String> {
    // Clone the writer out and drop the map lock first: `write_all` blocks
    // when the pty buffer is full (shell busy / not reading), and holding the
    // map lock there would freeze every other session op — including the
    // close path.
    let writer = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).map(|session| session.writer.clone())
    };
    let Some(writer) = writer else {
        // Session already gone (shell exited): dropping keystrokes is fine.
        return Ok(());
    };
    let mut writer = writer.lock().unwrap();
    writer
        .write_all(&data)
        .map_err(|e| format!("failed to write to session {id}: {e}"))
}

/// Resize the pty to match the frontend's xterm size.
#[tauri::command]
fn resize_session(
    state: State<'_, SessionManager>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to resize session {id}: {e}"))?;
    }
    Ok(())
}

/// 前端完成退出确认后置位：此后 `ExitRequested` 不再拦截，应用真正退出。
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Quit the app after the frontend has confirmed.
///
/// macOS `Cmd+Q` normally arrives as `RunEvent::ExitRequested`, which the run
/// loop turns into a `quit-requested` event for the frontend. Once the user
/// confirms, the frontend calls this command: the flag makes sure the exit is
/// not intercepted a second time.
#[tauri::command]
fn quit_app(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Report which sessions still have a foreground job or long-lived children.
///
/// Frontend calls this right before closing a tab/window; the answer decides
/// whether the confirmation dialog is shown.
#[tauri::command]
fn session_activity(state: State<'_, SessionManager>) -> Vec<SessionActivity> {
    /// Prompt helpers live for milliseconds; anything older is a real job.
    const MIN_AGE_SECS: u64 = 2;
    #[cfg(windows)]
    const EXCLUDED: &[&str] = &["conhost.exe", "OpenConsole.exe"];
    #[cfg(not(windows))]
    const EXCLUDED: &[&str] = &[];

    // Grab ids/pids under the lock, then release it before touching the OS.
    let sessions: Vec<(u64, u32, Option<u32>)> = {
        let sessions = state.sessions.lock().unwrap();
        sessions
            .iter()
            .filter_map(|(id, session)| {
                let pid = session.child.lock().unwrap().process_id()?;
                #[cfg(unix)]
                let pgid = session.master.process_group_leader().map(|p| p as u32);
                #[cfg(not(unix))]
                let pgid = None;
                Some((*id, pid, pgid))
            })
            .collect()
    };
    if sessions.is_empty() {
        return Vec::new();
    }

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All);
    let procs: Vec<ProcInfo> = system
        .processes()
        .iter()
        .map(|(pid, proc)| ProcInfo {
            pid: pid.as_u32(),
            ppid: proc.parent().map(|parent| parent.as_u32()),
            name: proc.name().to_string_lossy().to_string(),
            age_secs: proc.run_time(),
        })
        .collect();

    sessions
        .into_iter()
        .map(|(id, shell_pid, pgid)| {
            let (foreground, background) =
                busy_activity(shell_pid, pgid, &procs, MIN_AGE_SECS, EXCLUDED);
            SessionActivity {
                id,
                foreground,
                background,
            }
        })
        .collect()
}

/// Kill a session (closing the tab) and release its pty.
#[tauri::command]
fn kill_session(state: State<'_, SessionManager>, id: u64) -> Result<(), String> {
    // Remove under the lock, kill outside it — see `kill_all_sessions`.
    let removed = { state.sessions.lock().unwrap().remove(&id) };
    if let Some(session) = removed {
        let pid = session.child.lock().unwrap().process_id();
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
}

/// Return the merged user configuration (defaults + config.json) and the
/// config file path. Creates a default file on first run.
#[tauri::command]
fn get_config(app: AppHandle) -> ConfigPayload {
    let config = load_config(&app);
    let path = config_path(&app)
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    ConfigPayload { config, path }
}

/// Persist the user configuration to config.json.
#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let Some(path) = config_path(&app) else {
        return Err("config directory unavailable".to_string());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("write config: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of duplicating.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            spawn_shell,
            attach_session,
            session_cwd,
            write_session,
            resize_session,
            kill_session,
            get_config,
            save_config,
            quit_app,
            session_activity
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                kill_all_sessions(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // macOS 的 Cmd+Q 走 ExitRequested，不经过窗口的 close 事件；
            // 有窗口且用户还没确认时拦下来，交给前端弹确认框。
            // 没有窗口（用户已确认关窗）或已确认退出时放行。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested { api, .. } => {
                let has_window = !app.webview_windows().is_empty();
                if has_window && !QUIT_CONFIRMED.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("quit-requested", ());
                    }
                }
            }
            tauri::RunEvent::Exit => kill_all_sessions(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, ppid: Option<u32>, name: &str, age_secs: u64) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            name: name.to_string(),
            age_secs,
        }
    }

    #[test]
    fn busy_activity_reports_foreground_job() {
        let procs = vec![
            proc(100, None, "zsh", 500),
            proc(200, Some(100), "vim", 120),
        ];
        let (fg, bg) = busy_activity(100, Some(200), &procs, 2, &[]);
        assert_eq!(
            fg,
            Some(ActivityProcess {
                pid: 200,
                name: "vim".into()
            })
        );
        assert!(
            bg.is_empty(),
            "foreground pid must not repeat in background"
        );
    }

    #[test]
    fn busy_activity_ignores_idle_shell_and_prompt_helpers() {
        let procs = vec![
            proc(100, None, "zsh", 500),
            proc(200, Some(100), "oh-my-posh", 0),
        ];
        // Idle shell: foreground pgid == shell pid.
        let (fg, bg) = busy_activity(100, Some(100), &procs, 2, &[]);
        assert_eq!(fg, None);
        assert!(bg.is_empty(), "young helper processes are filtered out");
    }

    #[test]
    fn busy_activity_collects_long_lived_descendants() {
        let procs = vec![
            proc(100, None, "zsh", 500),
            proc(200, Some(100), "npm", 60),
            proc(300, Some(200), "node", 59),
            proc(400, Some(100), "git", 1),
        ];
        let (fg, bg) = busy_activity(100, None, &procs, 2, &[]);
        assert_eq!(fg, None);
        let names: Vec<_> = bg.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["node", "npm"]); // 名字排序，git 太新
    }

    #[test]
    fn busy_activity_skips_excluded_system_processes() {
        let procs = vec![
            proc(100, None, "pwsh", 500),
            proc(200, Some(100), "conhost.exe", 400),
            proc(300, Some(100), "cargo", 90),
        ];
        let (_, bg) = busy_activity(100, None, &procs, 2, &["conhost.exe"]);
        let names: Vec<_> = bg.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["cargo"]);
    }

    #[test]
    fn collect_descendants_walks_the_whole_tree() {
        let procs = vec![
            proc(100, None, "zsh", 500),
            proc(200, Some(100), "npm", 60),
            proc(300, Some(200), "node", 59),
            proc(400, Some(999), "unrelated", 59),
        ];
        let mut found = collect_descendants(&procs, 100);
        found.sort();
        assert_eq!(found, vec![200, 300]);
    }

    #[test]
    fn app_config_defaults() {
        let c = AppConfig::default();
        assert_eq!(c.shell, None);
        assert_eq!(c.font_size, 20);
        assert_eq!(c.font_family, None);
        assert_eq!(c.theme, "dark");
        assert!(c.cursor_blink);
        assert_eq!(c.scrollback, 10000);
        assert_eq!(c.start_cwd, None);
        assert!(c.confirm_on_running_processes);
    }

    #[test]
    fn app_config_partial_parse_keeps_defaults() {
        let c: AppConfig =
            serde_json::from_str(r#"{"font_size": 18, "theme": "dracula"}"#).unwrap();
        assert_eq!(c.font_size, 18);
        assert_eq!(c.theme, "dracula");
        assert_eq!(c.shell, None); // untouched → default
        assert_eq!(c.scrollback, 10000);
    }

    #[test]
    fn app_config_unknown_fields_ignored() {
        let c: AppConfig = serde_json::from_str(r#"{"bogus": 1, "font_size": 16}"#).unwrap();
        assert_eq!(c.font_size, 16);
        assert_eq!(c.theme, "dark");
    }

    #[test]
    fn app_config_roundtrip() {
        let c = AppConfig {
            shell: Some("cmd".into()),
            font_size: 20,
            font_family: Some("JetBrainsMono NFM".into()),
            theme: "tokyo-night".into(),
            cursor_blink: false,
            scrollback: 5000,
            start_cwd: Some(r"C:\work".into()),
            confirm_on_running_processes: false,
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.shell, c.shell);
        assert_eq!(back.font_size, c.font_size);
        assert_eq!(back.font_family, c.font_family);
        assert_eq!(back.theme, c.theme);
        assert_eq!(back.cursor_blink, c.cursor_blink);
        assert_eq!(back.scrollback, c.scrollback);
        assert_eq!(back.start_cwd, c.start_cwd);
        assert_eq!(
            back.confirm_on_running_processes,
            c.confirm_on_running_processes
        );
    }

    #[test]
    fn output_payload_base64_roundtrip() {
        let raw = b"hello \xe4\xb8\xad\xe6\x96\x87";
        let payload = OutputPayload {
            id: 7,
            data: STANDARD.encode(raw),
        };
        let decoded = STANDARD.decode(&payload.data).unwrap();
        assert_eq!(&decoded, raw);
    }

    /* ---------- cwd inheritance ---------- */

    /// Unique scratch directory for a test, created and removed by the caller.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("terminal-cwd-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_start_cwd_prefers_requested() {
        let requested = temp_dir("requested");
        let configured = temp_dir("configured");
        let picked = resolve_start_cwd(
            Some(requested.to_str().unwrap()),
            Some(configured.to_str().unwrap()),
        );
        assert_eq!(picked.as_deref(), Some(requested.as_path()));
        std::fs::remove_dir_all(&requested).ok();
        std::fs::remove_dir_all(&configured).ok();
    }

    #[test]
    fn resolve_start_cwd_falls_back_when_requested_is_gone() {
        // A tab may sit in a directory that was deleted meanwhile; handing that
        // path to `spawn_command` would make the shell fail to start.
        let configured = temp_dir("fallback");
        let missing = configured.join("does-not-exist");
        let picked = resolve_start_cwd(
            Some(missing.to_str().unwrap()),
            Some(configured.to_str().unwrap()),
        );
        assert_eq!(picked.as_deref(), Some(configured.as_path()));
        std::fs::remove_dir_all(&configured).ok();
    }

    #[test]
    fn resolve_start_cwd_uses_home_when_nothing_usable() {
        let picked = resolve_start_cwd(Some("/nonexistent-terminal-dir"), None);
        assert_eq!(picked, dirs::home_dir());
    }

    #[test]
    fn process_cwd_reads_own_working_directory() {
        // Round-trips the platform introspection (proc_pidinfo / PEB / /proc)
        // that `session_cwd` relies on: the pid of this very process must
        // report the directory the test is running in.
        let expected = std::env::current_dir().unwrap();
        let actual = process_cwd(std::process::id());
        assert_eq!(actual, Some(expected));
    }

    #[test]
    fn process_cwd_of_missing_process_is_none() {
        // Pid 0 is never a normal user process; the lookup must degrade to
        // `None` instead of panicking so `session_cwd` can fall back.
        assert_eq!(process_cwd(0), None);
    }
}
