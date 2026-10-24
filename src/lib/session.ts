import { invoke } from "@tauri-apps/api/core";

/**
 * Ask the backend where a session's shell currently is.
 *
 * Returns `null` instead of throwing when the lookup fails (session already
 * gone, or the OS would not report the cwd): the caller's fallback is simply
 * the default start directory, so a failure must stay quiet.
 */
export async function sessionCwd(id: number | null | undefined): Promise<string | null> {
  if (id == null) return null;
  try {
    return await invoke<string | null>("session_cwd", { id });
  } catch {
    return null;
  }
}

/**
 * Spawn a shell, optionally starting in `cwd`.
 *
 * `cwd` is passed as `null` (not omitted) so the Rust side always receives the
 * key; `Option<String>` only deserialises from an explicit `null`.
 */
export async function spawnShell(cwd: string | null = null): Promise<number> {
  return await invoke<number>("spawn_shell", { cwd });
}
