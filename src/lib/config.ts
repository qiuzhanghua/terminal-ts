import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `AppConfig` (config.json in the app config dir). */
export interface AppConfig {
  shell: string | null;
  fontSize: number;
  fontFamily: string | null;
  theme: string;
  cursorBlink: boolean;
  scrollback: number;
  startCwd: string | null;
}

export interface ConfigPayload {
  config: AppConfig;
  path: string;
}

export async function loadConfig(): Promise<ConfigPayload> {
  return await invoke<ConfigPayload>("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke("save_config", { config });
}
