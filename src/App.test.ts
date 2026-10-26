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
  closeHandler: null as ((e: { preventDefault: () => void }) => void) | null,
  quitHandler: null as (() => void) | null,
  activity: [] as unknown[],
  config: {
    shell: null,
    fontSize: 17,
    fontFamily: null,
    theme: "dark",
    cursorBlink: true,
    scrollback: 10000,
    startCwd: null,
    confirmOnRunningProcesses: true,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: mocks.setTitle,
    close: mocks.close,
    theme: mocks.theme,
    onCloseRequested: (cb: (e: { preventDefault: () => void }) => void) => {
      mocks.closeHandler = cb;
      return Promise.resolve(() => {});
    },
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    if (name === "quit-requested") mocks.quitHandler = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("./lib/config", () => ({
  loadConfig: async () => ({ config: mocks.config, path: "" }),
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
      emits: ["title-change", "exit", "zoom", "zoom-reset"],
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
  mocks.activity = [];
  mocks.config = {
    shell: null,
    fontSize: 17,
    fontFamily: null,
    theme: "dark",
    cursorBlink: true,
    scrollback: 10000,
    startCwd: null,
    confirmOnRunningProcesses: true,
  };
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "spawn_shell") return ++nextSessionId;
    if (cmd === "session_activity") return mocks.activity;
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
  await flushPromises();
  return wrapper;
}

/** 模拟点击窗口 X / Alt+F4：返回是否调用了 preventDefault。 */
async function requestWindowClose(): Promise<boolean> {
  const event = { preventDefault: vi.fn() };
  mocks.closeHandler?.(event);
  await flushPromises();
  return event.preventDefault.mock.calls.length > 0;
}

/** 模拟 macOS Cmd+Q 经 Rust 转发过来的 quit-requested。 */
async function requestAppQuit(): Promise<void> {
  mocks.quitHandler?.();
  await flushPromises();
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

  it("不在编辑时 Ctrl+Shift+W 照常关闭最后一个标签页（直接退出）", async () => {
    await mountApp();
    press("W", { ctrlKey: true, shiftKey: true });
    await flushPromises();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
  });
});

describe("退出确认", () => {
  it("没有改过名的标签页时直接退出，不弹窗", async () => {
    const w = await mountApp();
    expect(await requestWindowClose()).toBe(true);
    expect(w.find(".quit-dialog").exists()).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
  });

  it("有改过名的标签页时拦下关闭并列出主副行", async () => {
    const w = await mountApp();
    emitOsc(w, "q@host: ~/src");
    await nextTick();
    await renameTo(w, "构建");

    expect(await requestWindowClose()).toBe(true);
    const dialog = w.find(".quit-dialog");
    expect(dialog.exists()).toBe(true);
    expect(dialog.find(".quit-row-title").text()).toBe("构建");
    expect(dialog.find(".quit-row-sub").text()).toBe("q@host: ~/src");
  });

  it("取消后不关闭窗口，弹窗消失", async () => {
    const w = await mountApp();
    await renameTo(w, "构建");
    await requestWindowClose();

    await w.findAll(".quit-btn")[0].trigger("click");
    await flushPromises();

    expect(w.find(".quit-dialog").exists()).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("“仍要退出”调用 quit_app 退出应用", async () => {
    const w = await mountApp();
    await renameTo(w, "构建");
    await requestWindowClose();

    await w.find(".quit-btn.danger").trigger("click");
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
  });

  it("点击列表项等于取消退出并切到该标签页", async () => {
    const w = await mountApp();
    await renameTo(w, "第一个");
    press("T", { ctrlKey: true, shiftKey: true });
    await flushPromises();
    await renameTo(w, "第二个");

    await requestWindowClose();
    const rows = w.findAll(".quit-row");
    expect(rows).toHaveLength(2);
    await rows[0].trigger("click");
    await flushPromises();

    expect(w.find(".quit-dialog").exists()).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(w.findAll(".tab")[0].classes()).toContain("active");
  });

  it("弹窗开着时改名的标签页都退出，则自动放行关闭", async () => {
    const w = await mountApp();
    await renameTo(w, "构建");
    await requestWindowClose();
    expect(w.find(".quit-dialog").exists()).toBe(true);

    w.findComponent({ name: "TerminalView" }).vm.$emit("exit", 0);
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
  });

  it("macOS 的 quit-requested 复用同一个弹窗，确认后调用 quit_app", async () => {
    const w = await mountApp();
    await renameTo(w, "构建");
    await requestAppQuit();
    expect(w.find(".quit-dialog").exists()).toBe(true);

    await w.find(".quit-btn.danger").trigger("click");
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
  });

  it("有运行中进程（没改名）也会拦下并显示运行中 badge", async () => {
    const w = await mountApp();
    mocks.activity = [{ id: 1, foreground: { pid: 9, name: "cargo" }, background: [] }];

    expect(await requestWindowClose()).toBe(true);
    const dialog = w.find(".quit-dialog");
    expect(dialog.exists()).toBe(true);
    const badges = dialog.findAll(".quit-badge").map((b) => b.text());
    expect(badges).toContain("运行中 cargo");
  });

  it("关闭单个有进程的标签会先确认，确认后才 kill_session", async () => {
    const w = await mountApp();
    mocks.activity = [{ id: 1, foreground: { pid: 9, name: "cargo" }, background: [] }];

    await w.find(".tab-close").trigger("click");
    await flushPromises();

    expect(w.find(".quit-dialog").exists()).toBe(true);
    expect(w.find(".quit-title").text()).toBe("关闭标签页");
    expect(mocks.invoke).not.toHaveBeenCalledWith("kill_session", expect.anything());

    await w.find(".quit-btn.danger").trigger("click");
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("kill_session", { id: 1 });
  });

  it("关闭空闲标签不弹窗", async () => {
    const w = await mountApp();
    await w.find(".tab-close").trigger("click");
    await flushPromises();

    expect(w.find(".quit-dialog").exists()).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("kill_session", { id: 1 });
  });

  it("仅改过名但空闲的标签，关闭时不弹窗", async () => {
    const w = await mountApp();
    await renameTo(w, "构建");
    await w.find(".tab-close").trigger("click");
    await flushPromises();

    expect(w.find(".quit-dialog").exists()).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("kill_session", { id: 1 });
  });

  it("confirm_on_running_processes=false 时进程不再触发提醒", async () => {
    const w = await mountApp();
    mocks.config.confirmOnRunningProcesses = false;
    mocks.activity = [{ id: 1, foreground: { pid: 9, name: "cargo" }, background: [] }];

    // 配置在挂载时读取，这里重新挂载以生效
    w.unmount();
    const w2 = await mountApp();
    mocks.activity = [{ id: 1, foreground: { pid: 9, name: "cargo" }, background: [] }];
    await w2.vm.$nextTick();

    expect(await requestWindowClose()).toBe(true);
    expect(w2.find(".quit-dialog").exists()).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
  });

  it("没有改名标签页时 quit-requested 直接退出", async () => {
    await mountApp();
    await requestAppQuit();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
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
