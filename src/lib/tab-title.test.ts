import { describe, expect, it } from "vitest";
import {
  MAX_TITLE_CHARS,
  applyAutoTitle,
  displayTitle,
  makeTab,
  normalizeTitle,
} from "./tab-title";

describe("makeTab / displayTitle", () => {
  it("starts with Terminal and no custom title", () => {
    const tab = makeTab(3);
    expect(tab).toEqual({ id: 3, autoTitle: "Terminal", customTitle: null });
    expect(displayTitle(tab)).toBe("Terminal");
  });

  it("prefers the custom title over the shell one", () => {
    expect(displayTitle({ autoTitle: "q@host: ~/src", customTitle: "构建" })).toBe("构建");
  });
});

describe("applyAutoTitle", () => {
  it("updates autoTitle when the user has not renamed the tab", () => {
    const tab = applyAutoTitle(makeTab(1), "q@host: ~/src");
    expect(tab.autoTitle).toBe("q@host: ~/src");
    expect(displayTitle(tab)).toBe("q@host: ~/src");
  });

  it("never clobbers a custom title (oh-my-posh fires OSC on every prompt)", () => {
    const renamed = { ...makeTab(1), customTitle: "构建窗口" };
    const after = applyAutoTitle(renamed, "/var/log");
    expect(after.customTitle).toBe("构建窗口");
    expect(after.autoTitle).toBe("/var/log");
    expect(displayTitle(after)).toBe("构建窗口");
  });

  it("ignores an empty incoming title", () => {
    const tab = makeTab(1, "Terminal");
    expect(applyAutoTitle(tab, "")).toBe(tab);
  });
});

describe("normalizeTitle", () => {
  const auto = "q@host: ~/src";

  it("trims surrounding whitespace", () => {
    expect(normalizeTitle("  构建  ", auto)).toBe("构建");
  });

  it("returns null for empty or whitespace-only input (reset to auto)", () => {
    expect(normalizeTitle("", auto)).toBeNull();
    expect(normalizeTitle("   \t\n ", auto)).toBeNull();
    expect(normalizeTitle("\u3000", auto)).toBeNull();
  });

  it("returns null when the name equals the shell title", () => {
    expect(normalizeTitle(auto, auto)).toBeNull();
  });

  it("strips control characters, including newlines", () => {
    expect(normalizeTitle("构\n建\u0007 窗", auto)).toBe("构建 窗");
  });

  it("truncates to MAX_TITLE_CHARS code points", () => {
    const long = "字".repeat(MAX_TITLE_CHARS + 10);
    expect([...normalizeTitle(long, auto)!].length).toBe(MAX_TITLE_CHARS);
  });

  it("counts emoji by code point without splitting surrogate pairs", () => {
    const emoji = "🚀".repeat(MAX_TITLE_CHARS + 5);
    const out = normalizeTitle(emoji, auto)!;
    expect([...out].length).toBe(MAX_TITLE_CHARS);
    expect(out).toBe("🚀".repeat(MAX_TITLE_CHARS));
  });

  it("keeps interior spaces and CJK punctuation", () => {
    expect(normalizeTitle("api 服务 — 本地", auto)).toBe("api 服务 — 本地");
  });
});
