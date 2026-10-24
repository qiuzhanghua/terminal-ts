import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { sessionCwd, spawnShell } = await import("./session");

beforeEach(() => {
  invoke.mockReset();
});

describe("sessionCwd", () => {
  it("returns the backend's cwd for a session", async () => {
    invoke.mockResolvedValue("/home/q/dl");
    await expect(sessionCwd(3)).resolves.toBe("/home/q/dl");
    expect(invoke).toHaveBeenCalledWith("session_cwd", { id: 3 });
  });

  it("returns null without calling the backend when there is no session", async () => {
    await expect(sessionCwd(null)).resolves.toBeNull();
    await expect(sessionCwd(undefined)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows lookup failures so the caller keeps its default", async () => {
    invoke.mockRejectedValue(new Error("no such session 9"));
    await expect(sessionCwd(9)).resolves.toBeNull();
  });

  it("passes through a null cwd (process not inspectable)", async () => {
    invoke.mockResolvedValue(null);
    await expect(sessionCwd(4)).resolves.toBeNull();
  });
});

describe("spawnShell", () => {
  it("pins the inherited cwd as an explicit null when there is none", async () => {
    invoke.mockResolvedValue(7);
    await expect(spawnShell(null)).resolves.toBe(7);
    // `Option<String>` in Rust only deserialises from an explicit null; omitting
    // the key would fail with an invalid-args error.
    expect(invoke).toHaveBeenCalledWith("spawn_shell", { cwd: null });
  });

  it("forwards the cwd it was given", async () => {
    invoke.mockResolvedValue(8);
    await expect(spawnShell("/home/q/dl")).resolves.toBe(8);
    expect(invoke).toHaveBeenCalledWith("spawn_shell", { cwd: "/home/q/dl" });
  });

  it("defaults to null when called without an argument", async () => {
    invoke.mockResolvedValue(9);
    await spawnShell();
    expect(invoke).toHaveBeenCalledWith("spawn_shell", { cwd: null });
  });
});
