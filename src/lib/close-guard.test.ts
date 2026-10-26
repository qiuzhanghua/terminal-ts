import { describe, expect, it } from "vitest";
import { makeTab } from "./tab-title";
import {
  buildConfirmRows,
  isTabBusy,
  nextConfirmAction,
  type SessionActivity,
} from "./close-guard";

const busy = (id: number, foreground = "vim", background: string[] = []): SessionActivity => ({
  id,
  foreground: foreground ? { pid: 900 + id, name: foreground } : null,
  background: background.map((name, index) => ({ pid: 800 + id * 10 + index, name })),
});

describe("isTabBusy", () => {
  it("is true for a foreground job or long-lived background children", () => {
    expect(isTabBusy(busy(1))).toBe(true);
    expect(isTabBusy(busy(1, "", ["node"]))).toBe(true);
  });

  it("is false for an idle session or a missing one", () => {
    expect(isTabBusy({ id: 1, foreground: null, background: [] })).toBe(false);
    expect(isTabBusy(null)).toBe(false);
    expect(isTabBusy(undefined)).toBe(false);
  });
});

describe("buildConfirmRows (window close)", () => {
  it("lists renamed tabs and busy tabs, keeping tab order", () => {
    const tabs = [makeTab(1, "q@host: ~"), { ...makeTab(2, "/src"), customTitle: "构建" }, makeTab(3, "nvim")];
    const activity = [busy(3)];
    const rows = buildConfirmRows(tabs, activity);

    expect(rows.map((row) => row.id)).toEqual([2, 3]);
    expect(rows[0]).toMatchObject({ title: "构建", shellTitle: "/src", custom: true });
    expect(rows[1]).toMatchObject({ custom: false, foreground: { name: "vim" } });
  });

  it("is empty when nothing is renamed and everything is idle", () => {
    expect(buildConfirmRows([makeTab(1), makeTab(2)], [{ id: 1, background: [] }])).toEqual([]);
  });

  it("shows both reasons for a tab that has them", () => {
    const tabs = [{ ...makeTab(1, "/src"), customTitle: "构建" }];
    const rows = buildConfirmRows(tabs, [busy(1, "node")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].custom).toBe(true);
    expect(rows[0].foreground?.name).toBe("node");
  });
});

describe("buildConfirmRows (closing a single tab)", () => {
  it("returns the tab only when it is busy", () => {
    const tabs = [makeTab(1), { ...makeTab(2), customTitle: "改名但空闲" }];
    const rows = buildConfirmRows(tabs, [busy(1), { id: 2, background: [] }], { onlyId: 2 });
    expect(rows).toEqual([]); // 改名不是拦截关闭单个标签的理由
  });

  it("returns a single busy tab", () => {
    const tabs = [makeTab(1), makeTab(2)];
    const rows = buildConfirmRows(tabs, [busy(1, "cargo"), busy(2)], { onlyId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, foreground: { name: "cargo" } });
  });
});

describe("nextConfirmAction", () => {
  it("keeps the first request so repeated closes do not stack dialogs", () => {
    expect(nextConfirmAction(null, "quit")).toBe("quit");
    expect(nextConfirmAction("quit", "close-tab")).toBe("quit");
  });
});
