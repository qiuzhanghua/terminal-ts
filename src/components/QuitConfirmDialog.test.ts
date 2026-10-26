// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import QuitConfirmDialog from "./QuitConfirmDialog.vue";
import type { ConfirmRow } from "../lib/close-guard";

const rows: ConfirmRow[] = [
  {
    id: 1,
    title: "构建",
    shellTitle: "q@host: ~/src",
    custom: true,
    foreground: { pid: 9, name: "cargo" },
    background: [{ pid: 10, name: "node" }],
  },
  {
    id: 2,
    title: "q@host: ~",
    shellTitle: "q@host: ~",
    custom: false,
    foreground: null,
    background: [{ pid: 11, name: "npm" }],
  },
];

function mountDialog(action: "quit" | "close-tab" = "quit", activeId: number | null = 1) {
  return mount(QuitConfirmDialog, { props: { rows, action, activeId }, attachTo: document.body });
}

describe("QuitConfirmDialog", () => {
  it("shows a main line, badges for each reason, and the shell title", () => {
    const w = mountDialog();
    const first = w.findAll(".quit-row")[0];
    expect(first.find(".quit-row-title").text()).toBe("构建");
    expect(first.find(".quit-row-sub").text()).toBe("q@host: ~/src");
    const badges = first.findAll(".quit-badge").map((b) => b.text());
    expect(badges).toEqual(expect.arrayContaining(["自定义标题", "运行中 cargo", "后台 1 个进程"]));
    w.unmount();
  });

  it("uses quit wording for a window close", () => {
    const w = mountDialog("quit");
    expect(w.find(".quit-title").text()).toBe("退出确认");
    expect(w.find(".quit-btn.danger").text()).toBe("仍要退出");
    expect(w.find(".quit-note").text()).toContain("所有终端会话");
    w.unmount();
  });

  it("uses close wording for a single tab", () => {
    const w = mountDialog("close-tab");
    expect(w.find(".quit-title").text()).toBe("关闭标签页");
    expect(w.find(".quit-btn.danger").text()).toBe("仍要关闭");
    expect(w.find(".quit-note").text()).toContain("这个标签页");
    w.unmount();
  });

  it("marks the active tab and turns a row into a jump action", async () => {
    const w = mountDialog("quit", 2);
    const items = w.findAll(".quit-row");
    expect(items[0].classes()).not.toContain("active");
    expect(items[1].classes()).toContain("active");

    await items[0].trigger("click");
    expect(w.emitted("jump")).toEqual([[1]]);
    w.unmount();
  });

  it("emits cancel and confirm from the two buttons", async () => {
    const w = mountDialog();
    await w.findAll(".quit-btn")[0].trigger("click");
    expect(w.emitted("cancel")).toHaveLength(1);

    await w.find(".quit-btn.danger").trigger("click");
    expect(w.emitted("confirm")).toHaveLength(1);
    w.unmount();
  });

  it("cancels on Escape and on overlay click", async () => {
    const w = mountDialog();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(w.emitted("cancel")).toHaveLength(1);

    await w.find(".quit-overlay").trigger("click");
    expect(w.emitted("cancel")).toHaveLength(2);
    w.unmount();
  });

  it("focuses the cancel button by default", async () => {
    const w = mountDialog();
    await w.vm.$nextTick();
    expect(document.activeElement?.textContent).toBe("取消");
    w.unmount();
  });
});
