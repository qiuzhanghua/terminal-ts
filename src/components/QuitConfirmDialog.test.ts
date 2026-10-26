// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import QuitConfirmDialog from "./QuitConfirmDialog.vue";

const tabs = [
  { id: 1, title: "构建", shellTitle: "q@host: ~/src" },
  { id: 2, title: "编辑器", shellTitle: "nvim README.md" },
];

function mountDialog(activeId: number | null = 1) {
  return mount(QuitConfirmDialog, {
    props: { tabs, activeId },
    attachTo: document.body,
  });
}

describe("QuitConfirmDialog", () => {
  it("renders a main line and a dim shell-title line per tab", () => {
    const w = mountDialog();
    const rows = w.findAll(".quit-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".quit-row-title").text()).toBe("构建");
    expect(rows[0].find(".quit-row-sub").text()).toBe("q@host: ~/src");
    w.unmount();
  });

  it("marks the active tab and turns a row into a jump action", async () => {
    const w = mountDialog(2);
    const rows = w.findAll(".quit-row");
    expect(rows[0].classes()).not.toContain("active");
    expect(rows[1].classes()).toContain("active");

    await rows[0].trigger("click");
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
