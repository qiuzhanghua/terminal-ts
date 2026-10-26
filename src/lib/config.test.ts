import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("./config");

beforeEach(() => {
  invoke.mockReset();
});

describe("loadConfig", () => {
  it("maps the snake_case payload from Rust onto camelCase fields", async () => {
    invoke.mockResolvedValue({
      config: {
        shell: "/bin/zsh",
        font_size: 18,
        font_family: "JetBrainsMono NFM",
        theme: "dracula",
        cursor_blink: false,
        scrollback: 20000,
        start_cwd: "/home/q",
        confirm_on_running_processes: false,
      },
      path: "/home/q/.config/dev.taiji.terminal/config.json",
    });

    const { config, path } = await loadConfig();

    expect(invoke).toHaveBeenCalledWith("get_config");
    expect(config).toEqual({
      shell: "/bin/zsh",
      fontSize: 18,
      fontFamily: "JetBrainsMono NFM",
      theme: "dracula",
      cursorBlink: false,
      scrollback: 20000,
      startCwd: "/home/q",
      confirmOnRunningProcesses: false,
    });
    expect(path).toBe("/home/q/.config/dev.taiji.terminal/config.json");
  });

  it("falls back to the Rust defaults for missing fields", async () => {
    invoke.mockResolvedValue({ config: {}, path: "" });

    const { config } = await loadConfig();

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("does not mistake camelCase keys for the wire format", async () => {
    // 回归：前端曾经直接用 camelCase 字段读配置，font_size 被静默忽略，
    // 用户把 18 写进 config.json 却始终看到 16。
    invoke.mockResolvedValue({ config: { font_size: 20 }, path: "" });

    const { config } = await loadConfig();

    expect(config.fontSize).toBe(20);
  });
});

describe("saveConfig", () => {
  it("writes the snake_case shape Rust expects", async () => {
    await saveConfig({
      shell: null,
      fontSize: 18,
      fontFamily: null,
      theme: "dark",
      cursorBlink: true,
      scrollback: 10000,
      startCwd: null,
      confirmOnRunningProcesses: true,
    });

    expect(invoke).toHaveBeenCalledWith("save_config", {
      config: {
        shell: null,
        font_size: 18,
        font_family: null,
        theme: "dark",
        cursor_blink: true,
        scrollback: 10000,
        start_cwd: null,
        confirm_on_running_processes: true,
      },
    });
  });
});
