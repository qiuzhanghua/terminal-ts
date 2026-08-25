//! Tauri backend for the terminal emulator.
//!
//! Mirrors the shell-detection logic of the original `terminal` CLI project:
//! - Windows: pwsh -> powershell -> cmd
//! - Other: `$SHELL` env var, falling back to `/bin/bash`
//!
//! Each tab owns one real PTY session (ConPTY on Windows), streamed to the
//! frontend via `terminal-output` / `terminal-exit` events.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Window, WindowEvent};

/// Max bytes forwarded per `terminal-output` event.
const READ_CHUNK: usize = 8192;

/// A live shell session backed by a PTY.
struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

#[derive(Default)]
struct SessionManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Session>>,
}

#[derive(Clone, Serialize)]
struct OutputPayload {
    id: u64,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: u64,
    code: Option<u32>,
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

fn kill_all_sessions(app: &AppHandle) {
    let state = app.state::<SessionManager>();
    let sessions = state.sessions.lock().unwrap();
    for session in sessions.values() {
        let _ = session.child.lock().unwrap().kill();
    }
}

/// Spawn a new shell session and return its id. The pty reader runs on a
/// background thread and forwards output to the frontend as events.
#[tauri::command]
fn spawn_shell(window: Window, state: State<'_, SessionManager>) -> Result<u64, String> {
    let shell = detect_shell();

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Suppress pwsh startup noise: version banner, update notice and
    // profile-load-time message.
    if shell == "pwsh" {
        cmd.arg("-NoLogo");
        cmd.arg("-NoProfileLoadTime");
        cmd.env("POWERSHELL_UPDATECHECK", "Off");
    } else if shell == "powershell" {
        cmd.arg("-NoLogo");
        cmd.env("POWERSHELL_UPDATECHECK", "Off");
    }
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
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

    state.sessions.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer, child: child_shared.clone() },
    );

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = OutputPayload { id, data: buf[..n].to_vec() };
                    if window.emit("terminal-output", payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        // The pty closed: poll for the real exit code without blocking forever.
        let mut code: Option<u32> = None;
        for _ in 0..200 {
            match child_shared.lock().unwrap().try_wait() {
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

    Ok(id)
}

/// Write keystrokes from the frontend into the session's pty.
#[tauri::command]
fn write_session(state: State<'_, SessionManager>, id: u64, data: Vec<u8>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        session
            .writer
            .write_all(&data)
            .map_err(|e| format!("failed to write to session {id}: {e}"))?;
    }
    Ok(())
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
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("failed to resize session {id}: {e}"))?;
    }
    Ok(())
}

/// Kill a session (closing the tab) and release its pty.
#[tauri::command]
fn kill_session(state: State<'_, SessionManager>, id: u64) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&id) {
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            spawn_shell,
            write_session,
            resize_session,
            kill_session
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                kill_all_sessions(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                kill_all_sessions(app);
            }
        });
}
