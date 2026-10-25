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

/**
 * 磁盘上的 config.json 和 Rust 侧的 IPC 都是 snake_case（Rust 的 `AppConfig`
 * 没有加 `#[serde(rename_all = "camelCase")]`），前端内部统一用 camelCase，
 * 所以边界上必须转换一次——否则 `font_size` / `font_family` / `cursor_blink` /
 * `start_cwd` 会被静默忽略，永远落到默认值。
 */
export interface RawConfig {
  shell?: string | null;
  font_size?: number;
  font_family?: string | null;
  theme?: string;
  cursor_blink?: boolean;
  scrollback?: number;
  start_cwd?: string | null;
}

/** Rust 侧 `AppConfig::default()` 的镜像，配置缺字段时用它兜底。 */
export const DEFAULT_CONFIG: AppConfig = {
  shell: null,
  fontSize: 20,
  fontFamily: null,
  theme: "dark",
  cursorBlink: true,
  scrollback: 10000,
  startCwd: null,
};

export function fromRaw(raw: RawConfig): AppConfig {
  return {
    shell: raw.shell ?? DEFAULT_CONFIG.shell,
    fontSize: raw.font_size ?? DEFAULT_CONFIG.fontSize,
    fontFamily: raw.font_family ?? DEFAULT_CONFIG.fontFamily,
    theme: raw.theme ?? DEFAULT_CONFIG.theme,
    cursorBlink: raw.cursor_blink ?? DEFAULT_CONFIG.cursorBlink,
    scrollback: raw.scrollback ?? DEFAULT_CONFIG.scrollback,
    startCwd: raw.start_cwd ?? DEFAULT_CONFIG.startCwd,
  };
}

export function toRaw(config: AppConfig): RawConfig {
  return {
    shell: config.shell,
    font_size: config.fontSize,
    font_family: config.fontFamily,
    theme: config.theme,
    cursor_blink: config.cursorBlink,
    scrollback: config.scrollback,
    start_cwd: config.startCwd,
  };
}

export async function loadConfig(): Promise<ConfigPayload> {
  const payload = await invoke<{ config: RawConfig; path: string }>("get_config");
  return { config: fromRaw(payload.config), path: payload.path };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke("save_config", { config: toRaw(config) });
}
