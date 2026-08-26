/**
 * Terminal font chain.
 *
 * xterm uses the canvas renderer. On WebKit the leading family decides the
 * whole face: if it is not installed, canvas falls back to a proportional
 * default and never reaches the rest of the chain. On Blink (Windows WebView2)
 * missing glyphs fall back per-glyph, so later families still contribute
 * (PUA icons, CJK). Either way the chain MUST start from a font that is really
 * installed, so we probe availability with a DOM measure against a
 * deliberately-missing sentinel family (both ending in `monospace`) and lead
 * with the best font that is present.
 *
 * Preference order (best first):
 *   1. Nerd-patched ligature fonts — one font carrying BOTH the `calt`
 *      ligature glyphs (`->`, `=>`, `===`) and the oh-my-posh PUA icons.
 *   2. Plain ligature monospaces (JetBrains Mono / Fira Code / Cascadia Code)
 *      — ligatures work; on Blink the PUA icons fall back to a Nerd Font later
 *      in the chain.
 *   3. Plain Nerd Fonts (MesloLGM Nerd Font Mono, …) — icons guaranteed, but
 *      no ligatures.
 *   4. System monospace (Menlo, guaranteed on macOS) as a safe fallback, then
 *      CJK fonts so Chinese text never lands on the PUA-mapping CJK glyphs.
 *
 * Availability is probed with a DOM measure against a deliberately-missing
 * sentinel family (both ending in `monospace`). An unavailable font falls back
 * to `monospace` and measures equal to the sentinel → correctly excluded. An
 * installed font with a distinct advance (Nerd Fonts, JetBrains Mono/Fira
 * Code/Cascadia — i.e. the ones we might want to lead with) measures
 * differently and is included. We deliberately do NOT use `serif`/`sans` as a
 * reference (WebKit falls to the default font, not the generic, for unknown
 * families → false positives), nor `monospace` alone (it IS Menlo on macOS,
 * and Menlo precisely cancels out).
 *
 * Invariants:
 * - An installed ligature font leads ⇒ `->`, `=>` render as ligatures.
 * - A Nerd Font stays in the chain ⇒ oh-my-posh PUA icons (U+E0B0–U+E0B6, …)
 *   resolve there instead of being mapped to CJK ideographs (`瞵間`).
 * - System monospace (Menlo) always remains as a guaranteed monospace fallback.
 */

// Nerd-patched ligature fonts: ligature glyphs AND PUA icons in one font.
// (FiraCode Nerd Font Mono is the classic example; JetBrainsMono Nerd Font /
// CaskaydiaCove Nerd Font are the JetBrains Mono / Cascadia Code equivalents.)
const LIGATURE_NERD_FONTS = [
  "JetBrainsMono Nerd Font Mono",
  "FiraCode Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaCove Nerd Font Mono",
  "SauceCodePro Nerd Font Mono",
];

const LIGATURE_MONOS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
];

const NERD_FONTS = [
  "MesloLGM Nerd Font Mono",
  "Hack Nerd Font Mono",
  "UbuntuMono Nerd Font Mono",
];

// Always-listed system monospace fallbacks. Menlo first: it is guaranteed on
// macOS and is what WebKit's canvas resolves to by default, so it can always
// serve as a safe lead/fallback. (It has no ligatures.)
const SYSTEM_MONOS = [
  "Menlo",
  "SF Mono",
  "Monaco",
  "Consolas",
  "Fira Mono",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Courier New",
];

const CJK_FONTS = [
  "PingFang SC",
  "Hiragino Sans GB",
  "Noto Sans CJK SC",
  "Noto Sans SC",
  "Microsoft YaHei",
  "WenQuanYi Micro Hei",
  "SimHei",
];

const MISSING = "__missing_font_sentinel_123__";

/** True if `family` resolves to a real font (advance differs from the sentinel). */
function isFontAvailable(family: string): boolean {
  try {
    const s = document.createElement("span");
    Object.assign(s.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre" });
    s.textContent = "mmmmmmmmmmlli";
    document.body.appendChild(s);
    s.style.font = `14px "${family}", monospace`;
    const withFont = s.getBoundingClientRect().width;
    s.style.font = `14px "${MISSING}", monospace`;
    const missing = s.getBoundingClientRect().width;
    s.remove();
    // Installed ligature fonts (e.g. JetBrains Mono) differ from the Menlo
    // fallback by a small but real amount (~0.4px); truly-missing fonts equal
    // the sentinel (~0.00). Threshold 0.1 catches the former without false
    // positives on the latter.
    return Math.abs(withFont - missing) > 0.1;
  } catch {
    return false;
  }
}

export function buildTerminalFontFamily(): string {
  const detected = [...LIGATURE_NERD_FONTS, ...LIGATURE_MONOS, ...NERD_FONTS].filter(isFontAvailable);
  const chain = [...detected, ...SYSTEM_MONOS, ...CJK_FONTS, "ui-monospace", "monospace"];
  return chain.map((f) => `"${f}"`).join(", ");
}
