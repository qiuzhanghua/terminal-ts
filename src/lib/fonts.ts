/**
 * Terminal font chain.
 *
 * xterm uses the canvas renderer, whose font resolution only honors the FIRST
 * family that WebKit can actually resolve: if the leading family is not
 * installed, canvas falls back to a proportional default and never reaches the
 * rest of the chain. So a static chain that starts with e.g. an uninstalled
 * Nerd Font renders the whole terminal proportionally. We therefore lead with
 * the best NERD/LIGATURE font that is really installed, then keep system
 * monospace (Menlo, guaranteed on macOS) and CJK as plain fallbacks.
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
 * - An installed Nerd Font leads ⇒ oh-my-posh PUA icons (U+E0B0–U+E0B6, …)
 *   resolve there instead of being mapped to CJK ideographs (`瞵間`).
 * - System monospace (Menlo) always remains as a guaranteed monospace fallback.
 */

const NERD_FONTS = [
  "MesloLGM Nerd Font Mono",
  "JetBrainsMono Nerd Font Mono",
  "FiraCode Nerd Font Mono",
  "SauceCodePro Nerd Font Mono",
  "Hack Nerd Font Mono",
  "UbuntuMono Nerd Font Mono",
];

const LIGATURE_MONOS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
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
  const detected = [...NERD_FONTS, ...LIGATURE_MONOS].filter(isFontAvailable);
  const chain = [...detected, ...SYSTEM_MONOS, ...CJK_FONTS, "ui-monospace", "monospace"];
  return chain.map((f) => `"${f}"`).join(", ");
}
