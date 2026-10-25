// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import type { VueWrapper } from "@vue/test-utils";

/**
 * App.vue 的组件级测试：重命名入口、编辑态快捷键让路、OSC 与自定义标题的
 * 优先级、右键菜单、焦点归还。
 *
 * 后端与 xterm 都被替身掉：TerminalView 只保留 `fit` / `focus` 两个能力和
 * `title-change` 事件——测试关心的是「标题怎么来的」，不是终端怎么渲染。
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setTitle: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  theme: vi.fn(async () => "dark"),
  fit: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: mocks.setTitle,
    close: mocks.close,
    theme: mocks.theme,
  }),
}));

vi.mock("./lib/config", () => ({
  loadConfig: async () => ({
    config: {
      theme: "dark",
      fontSize: 17,
      fontFamily: null,
      cursorBlink: true,
      scrollback: 10000,
    },
  }),
}));

vi.mock("./components/TerminalView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "TerminalView",
      props: {
        sessionId: Number,
        fontSize: Number,
        fontFamily: String,
        theme: Object,
        cursorBlink: Boolean,
        scrollback: Number,
      },
      emits: ["title-change", "exit"],
      setup(_props, { expose }) {
        expose({ fit: mocks.fit, focus: mocks.focus });
        return () => h("div", { class: "terminal-stub" });
      },
    }),
  };
});

const App = (await import("./App.vue")).default;

let wrapper: VueWrapper | null = null;
let nextSessionId = 0;

beforeEach(() => {
  vi.clearAllMocks();
  nextSessionId = 0;
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "spawn_shell") return ++nextSessionId;
    return null;
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

async function mountApp(): Promise<VueWrapper> {
  wrapper = mount(App, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

/** 全局快捷键挂在 window 上（capture），所以从 window 派发。 */
function press(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
}

function emitOsc(w: VueWrapper, title: string): void {
  w.findComponent({ name: "TerminalView" }).vm.$emit("title-change", title);
}

async function renameTo(w: VueWrapper, name: string): Promise<void> {
  press("F2");
  await nextTick();
  const input = w.find(".tab-input");
  await input.setValue(name);
  await input.trigger("keydown", { key: "Enter" });
  await flushPromises();
}

describe("初始状态", () => {
  it("启动后有一个标签页，窗口标题是派生值", async () => {
    const w = await mountApp();
    expect(w.findAll(".tab")).toHaveLength(1);
    expect(w.find(".tab-title").text()).toBe("Terminal");
    expect(mocks.setTitle).toHaveBeenCalledWith("Terminal — Terminal");
    // 配置里的字号要真的传到终端组件，而不是永远用 16（见 lib/config.ts 的边界转换）。
    expect(w.findComponent({ name: "TerminalView" }).props("fontSize")).toBe(17);
  });
});

describe("字号联动", () => {
  it("tab 栏字号与终端一致（配置 17 → 17px，系数 1.0）", async () => {
    const w = await mountApp();
    expect(w.find(".tabbar").attributes("style")).toContain("font-size: 17px");
  });

  it("缩放事件同步到终端 props 和 tab 栏", async () => {
    const w = await mountApp();
    w.findComponent({ name: "TerminalView" }).vm.$emit("zoom", 20);
    await nextTick();

    expect(w.findComponent({ name: "TerminalView" }).props("fontSize")).toBe(20);
    expect(w.find(".tabbar").attributes("style")).toContain("font-size: 20px");
  });

  it("重置回到配置里的原始字号，而不是缩放后的值", async () => {
    const w = await mountApp();
    const term = w.findComponent({ name: "TerminalView" });
    term.vm.$emit("zoom", 24);
    await nextTick();
    expect(term.props("fontSize")).toBe(24);

    term.vm.$emit("zoom-reset");
    await nextTick();
    expect(term.props("fontSize")).toBe(17);
    expect(w.find(".tabbar").attributes("style")).toContain("font-size: 17px");
  });
});

describe("进入编辑", () => {
  it("F2 打开行内输入框并预填当前标题", async () => {
    const w = await mountApp();
    press("F2");
    await nextTick();

    const input = w.find(".tab-input");
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe("Terminal");
    expect(w.find(".tab-title").exists()).toBe(false);
  });

  it("双击标签页也能进入编辑", async () => {
    const w = await mountApp();
    await w.find(".tab").trigger("dblclick");
    await nextTick();
    expect(w.find(".tab-input").exists()).toBe(true);
  });

  it("双击关闭按钮不进入编辑", async () => {
    const w = await mountApp();
    await w.find(".tab-close").trigger("dblclick");
    await nextTick();
    expect(w.find(".tab-input").exists()).toBe(false);
  });

  it("F2 在 xterm 的隐藏 textarea 上触发时依然生效（回归）", async () => {
    const w = await mountApp();
    // xterm 把键盘输入收在 <textarea class="xterm-helper-textarea"> 里，
    // 这里模拟事件从 textarea 冒泡上来，快捷键必须仍然让位给重命名。
    const helper = document.createElement("textarea");
    document.body.appendChild(helper);
    helper.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    await nextTick();

    expect(w.find(".tab-input").exists()).toBe(true);
    helper.remove();
  });
});

describe("提交与取消", () => {
  it("Enter 提交自定义标题，窗口标题同步，焦点还给终端", async () => {
    const w = await mountApp();
    await renameTo(w, "build");

    expect(w.find(".tab-title").text()).toBe("build");
    expect(w.find(".tab-title").classes()).toContain("custom");
    expect(mocks.setTitle).toHaveBeenLastCalledWith("build — Terminal");
    expect(mocks.focus).toHaveBeenCalled();
  });

  it("Esc 取消，不改变标题也不改窗口标题", async () => {
    const w = await mountApp();
    press("F2");
    await nextTick();
    const input = w.find(".tab-input");
    await input.setValue("discarded");
    await input.trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(w.find(".tab-title").text()).toBe("Terminal");
    expect(mocks.setTitle).not.toHaveBeenCalledWith("discarded — Terminal");
  });

  it("失焦算提交", async () => {
    const w = await mountApp();
    press("F2");
    await nextTick();
    const input = w.find(".tab-input");
    await input.setValue("blurred");
    await input.trigger("blur");
    await flushPromises();

    expect(w.find(".tab-title").text()).toBe("blurred");
    expect(mocks.setTitle).toHaveBeenLastCalledWith("blurred — Terminal");
  });

  it("提交空串或纯空白回落到 shell 标题", async () => {
    const w = await mountApp();
    emitOsc(w, "q@host: ~/src");
    await nextTick();
    await renameTo(w, "temp");
    expect(w.find(".tab-title").text()).toBe("temp");

    await renameTo(w, "   ");
    expect(w.find(".tab-title").text()).toBe("q@host: ~/src");
    expect(w.find(".tab-title").classes()).not.toContain("custom");
  });

  it("提交与 shell 标题相同的内容按“跟随 shell”处理", async () => {
    const w = await mountApp();
    await renameTo(w, "Terminal");
    expect(w.find(".tab-title").classes()).not.toContain("custom");
  });

  it("IME 组合期间的 Enter 只确认候选，不提交", async () => {
    const w = await mountApp();
    press("F2");
    await nextTick();
    const input = w.find(".tab-input");
    await input.setValue("拼音");
    await input.trigger("compositionstart");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(w.find(".tab-input").exists()).toBe(true);

    await input.trigger("compositionend");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(w.find(".tab-input").exists()).toBe(false);
    expect(w.find(".tab-title").text()).toBe("拼音");
  });
});

describe("OSC 与自定义标题的优先级", () => {
  it("OSC 只更新自动标题，显示值仍是自定义标题", async () => {
    const w = await mountApp();
    await renameTo(w, "build");

    emitOsc(w, "/var/log");
    await nextTick();

    expect(w.find(".tab-title").text()).toBe("build");
    expect(mocks.setTitle).toHaveBeenLastCalledWith("build — Terminal");
  });

  it("没有自定义标题时 OSC 直接生效", async () => {
    const w = await mountApp();
    emitOsc(w, "/var/log");
    await nextTick();

    expect(w.find(".tab-title").text()).toBe("/var/log");
    expect(mocks.setTitle).toHaveBeenLastCalledWith("/var/log — Terminal");
  });
});

describe("快捷键让路", () => {
  it("编辑中按 Ctrl+Shift+W 不关闭标签页", async () => {
    const w = await mountApp();
    press("F2");
    await nextTick();

    press("W", { ctrlKey: true, shiftKey: true });
    await flushPromises();

    expect(w.findAll(".tab")).toHaveLength(1);
    expect(w.find(".tab-input").exists()).toBe(true);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("kill_session", expect.anything());
  });

  it("不在编辑时 Ctrl+Shift+W 照常关闭最后一个标签页", async () => {
    await mountApp();
    press("W", { ctrlKey: true, shiftKey: true });
    await flushPromises();
    expect(mocks.close).toHaveBeenCalled();
  });
});

describe("右键菜单", () => {
  it("三项齐全，没有自定义标题时“恢复自动标题”不可用", async () => {
    const w = await mountApp();
    await w.find(".tab").trigger("contextmenu", { clientX: 20, clientY: 20 });
    await nextTick();

    const items = w.findAll(".tab-menu-item");
    expect(items.map((i) => i.text())).toEqual([
      expect.stringContaining("重命名"),
      expect.stringContaining("恢复自动标题"),
      expect.stringContaining("关闭标签页"),
    ]);
    expect(items[1].attributes("disabled")).toBeDefined();

    press("Escape");
    await nextTick();
    expect(w.find(".tab-menu").exists()).toBe(false);
  });

  it("菜单字号与 tab 栏保持一致", async () => {
    const w = await mountApp();
    await w.find(".tab").trigger("contextmenu", { clientX: 20, clientY: 20 });
    await nextTick();

    expect(w.find(".tab-menu").attributes("style")).toContain("font-size: 17px");

    press("Escape");
    await nextTick();
  });

  it("“恢复自动标题”清掉自定义标题并回到 shell 标题", async () => {
    const w = await mountApp();
    emitOsc(w, "q@host: ~");
    await nextTick();
    await renameTo(w, "menu-test");
    expect(w.find(".tab-title").text()).toBe("menu-test");

    await w.find(".tab").trigger("contextmenu", { clientX: 20, clientY: 20 });
    await nextTick();
    const items = w.findAll(".tab-menu-item");
    expect(items[1].attributes("disabled")).toBeUndefined();

    await items[1].trigger("click");
    await flushPromises();

    expect(w.find(".tab-menu").exists()).toBe(false);
    expect(w.find(".tab-title").text()).toBe("q@host: ~");
    expect(mocks.setTitle).toHaveBeenLastCalledWith("q@host: ~ — Terminal");
  });
});
