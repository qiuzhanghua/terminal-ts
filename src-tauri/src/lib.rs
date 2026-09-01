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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Window, WindowEvent};

/// Max bytes read from the pty per `terminal-output` event. Output is
/// base64-encoded, so larger chunks stay compact on the wire.
const READ_CHUNK: usize = 65536;

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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            shell: None,
            font_size: 16,
            font_family: None,
            theme: "dark".to_string(),
            cursor_blink: true,
            scrollback: 10000,
            start_cwd: None,
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
fn spawn_shell(
    app: AppHandle,
    window: Window,
    state: State<'_, SessionManager>,
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
    // cwd priority: config.start_cwd > home dir.
    if let Some(cwd) = config.start_cwd.clone().filter(|c| Path::new(c).is_dir()) {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs::home_dir() {
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
    let child_for_watcher = child_shared.clone();

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            child: child_shared.clone(),
        },
    );

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = OutputPayload {
                        id,
                        data: STANDARD.encode(&buf[..n]),
                    };
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
                match child_watcher.lock().unwrap().try_wait() {
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

/// Kill a session (closing the tab) and release its pty.
#[tauri::command]
fn kill_session(state: State<'_, SessionManager>, id: u64) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&id) {
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
            write_session,
            resize_session,
            kill_session,
            get_config,
            save_config
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_config_defaults() {
        let c = AppConfig::default();
        assert_eq!(c.shell, None);
        assert_eq!(c.font_size, 16);
        assert_eq!(c.font_family, None);
        assert_eq!(c.theme, "dark");
        assert!(c.cursor_blink);
        assert_eq!(c.scrollback, 10000);
        assert_eq!(c.start_cwd, None);
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
            font_size: 16,
            font_family: Some("JetBrainsMono NFM".into()),
            theme: "tokyo-night".into(),
            cursor_blink: false,
            scrollback: 5000,
            start_cwd: Some(r"C:\work".into()),
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
}
