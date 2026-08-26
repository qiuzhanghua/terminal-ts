import { describe, expect, it } from "vitest";
import { isLightTheme, resolveTheme } from "./themes";

describe("resolveTheme", () => {
  it("returns the preset for a known name", () => {
    expect(resolveTheme("dracula", null).background).toBe("#282a36");
    expect(resolveTheme("light", null).background).toBe("#ffffff");
    expect(resolveTheme("tokyo-night", null).background).toBe("#1a1b26");
  });

  it("follows the system theme with followSystem", () => {
    expect(resolveTheme("followSystem", "light").background).toBe("#ffffff");
    expect(resolveTheme("followSystem", "dark").background).toBe("#1e1e1e");
    // unknown system theme → dark
    expect(resolveTheme("followSystem", null).background).toBe("#1e1e1e");
  });

  it("falls back to dark for unknown names", () => {
    expect(resolveTheme("does-not-exist", null).background).toBe("#1e1e1e");
  });
});

describe("isLightTheme", () => {
  it("detects explicit light", () => {
    expect(isLightTheme("light", null)).toBe(true);
    expect(isLightTheme("dark", null)).toBe(false);
  });

  it("follows the system theme", () => {
    expect(isLightTheme("followSystem", "light")).toBe(true);
    expect(isLightTheme("followSystem", "dark")).toBe(false);
  });
});
