import { describe, expect, it } from "vitest";
import { makeTab } from "./tab-title";
import { needsQuitConfirm, nextPendingClose, renamedTabs } from "./close-guard";

function tabWithTitle(id: number, autoTitle: string, customTitle: string | null) {
  return { ...makeTab(id, autoTitle), customTitle };
}

describe("renamedTabs", () => {
  it("keeps only user-renamed tabs, in tab order", () => {
    const tabs = [
      tabWithTitle(1, "q@host: ~", null),
      tabWithTitle(2, "/var/log", "构建"),
      tabWithTitle(3, "nvim", "编辑器"),
    ];
    expect(renamedTabs(tabs)).toEqual([
      { id: 2, title: "构建", shellTitle: "/var/log" },
      { id: 3, title: "编辑器", shellTitle: "nvim" },
    ]);
  });

  it("is empty when every tab still follows the shell title", () => {
    expect(renamedTabs([makeTab(1), makeTab(2, "/tmp")])).toEqual([]);
  });

  it("does not count OSC-only titles (autoTitle) as renamed", () => {
    const tabs = [makeTab(1), makeTab(2)];
    expect(needsQuitConfirm(tabs)).toBe(false);
  });
});

describe("needsQuitConfirm", () => {
  it("is true as soon as one tab has a custom title", () => {
    expect(needsQuitConfirm([makeTab(1), tabWithTitle(2, "/tmp", "build")])).toBe(true);
  });
});

describe("nextPendingClose", () => {
  it("starts a pending action when idle", () => {
    expect(nextPendingClose(null, "close-window")).toBe("close-window");
    expect(nextPendingClose(null, "quit-app")).toBe("quit-app");
  });

  it("keeps the first action when another request arrives (no stacked dialogs)", () => {
    expect(nextPendingClose("close-window", "quit-app")).toBe("close-window");
    expect(nextPendingClose("quit-app", "close-window")).toBe("quit-app");
  });
});
