<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { buildTerminalFontFamily } from "../lib/fonts";
import { THEME_PRESETS } from "../lib/themes";

const props = defineProps<{
  sessionId: number;
  /** Configurable terminal options (from config.json); fall back to defaults. */
  fontSize?: number;
  fontFamily?: string;
  theme?: ITheme;
  cursorBlink?: boolean;
  scrollback?: number;
}>();

const emit = defineEmits<{
  (e: "title-change", title: string): void;
  (e: "exit", code: number | null): void;
}>();

const host = ref<HTMLDivElement | null>(null);
const searchVisible = ref(false);
const searchTerm = ref("");
const searchInput = ref<HTMLInputElement | null>(null);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null;
let unlisteners: UnlistenFn[] = [];
let resizeObserver: ResizeObserver | null = null;
let dead = false;

function fit(): void {
  if (!fitAddon || dead) return;
  const el = host.value;
  // Skip hidden (v-show display:none) terminals: fitting a 0-size element
  // resizes the PTY to 1-2 columns, which makes the shell repaint and can
  // wipe the terminal buffer (lost history when switching tabs).
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
  try {
    fitAddon.fit();
  } catch {
    // element may be hidden (v-show) or not yet laid out; retry on next show
  }
}

function focus(): void {
  term?.focus();
}

defineExpose({ fit, focus });

/* ---------- clipboard ---------- */

async function copySelection(): Promise<void> {
  if (!term) return;
  const sel = term.getSelection();
  if (!sel) return;
  try {
    await writeText(sel);
  } catch (e) {
    console.error("copy failed:", e);
  }
}

async function pasteClipboard(): Promise<void> {
  if (dead || !term) return;
  try {
    const text = await readText();
    if (!text) return;
    const bytes = Array.from(new TextEncoder().encode(text));
    invoke("write_session", { id: props.sessionId, data: bytes }).catch(() => {});
  } catch (e) {
    console.error("paste failed:", e);
  }
}

/* ---------- zoom ---------- */

function zoomBy(delta: number): void {
  if (!term) return;
  const current = term.options.fontSize ?? 16;
  const next = Math.min(48, Math.max(8, current + delta));
  if (next !== current) {
    term.options.fontSize = next;
    fit();
  }
}

function resetZoom(): void {
  if (!term) return;
  term.options.fontSize = props.fontSize ?? 16;
  fit();
}

/* ---------- search ---------- */

function openSearch(): void {
  if (!term) return;
  searchVisible.value = true;
  nextTick(() => searchInput.value?.focus());
}

function closeSearch(): void {
  searchVisible.value = false;
  searchTerm.value = "";
  searchAddon?.clearDecorations();
  term?.focus();
}

function find(next: boolean): void {
  if (!searchAddon || !searchTerm.value) return;
  if (next) searchAddon.findNext(searchTerm.value, { incremental: true });
  else searchAddon.findPrevious(searchTerm.value, { incremental: true });
}

onMounted(async () => {
  if (!host.value) return;

  term = new Terminal({
    // Leading font is detected at runtime (after document.fonts is ready) so
    // the renderer always lands on an installed, monospace font; an installed
    // ligature / Nerd font is preferred. config.json can override with
    // `fontFamily` / `font_size` / `theme` / `cursor_blink` / `scrollback`.
    fontFamily: props.fontFamily && props.fontFamily.length > 0 ? props.fontFamily : await buildTerminalFontFamily(),
    fontSize: props.fontSize ?? 16,
    lineHeight: 1.2,
    cursorBlink: props.cursorBlink ?? true,
    scrollback: props.scrollback ?? 10000,
    // LigaturesAddon registers a character joiner, which xterm.js marks as
    // (EXPERIMENTAL) and gates behind this flag; without it loadAddon throws
    // and the whole terminal setup (event listeners included) is skipped.
    allowProposedApi: true,
    theme: props.theme ?? THEME_PRESETS.dark,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  term.open(host.value);
  fit();
  // Auto-focus so the user can type immediately (e.g. right after launch).
  term.focus();

  // Ligatures (e.g. -> => for JetBrains Mono / Fira Code). The joiner API is
  // DOM-renderer-only, which is fine: since xterm 6.0.0 the DOM renderer also
  // paints backgrounds on space characters, so colors and ligatures coexist.
  // Guarded because @xterm/addon-ligatures 0.10 predates xterm 6; if it throws
  // mid-onMounted the listeners below would never register.
  try {
    term.loadAddon(new LigaturesAddon());
  } catch (e) {
    console.error("ligatures addon failed to load:", e);
  }

  // Terminal-level shortcuts. Returning false means xterm neither handles the
  // key nor sends it to the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const ctrlShift = e.ctrlKey && e.shiftKey;
    if (ctrlShift && e.key === "C") {
      e.preventDefault();
      copySelection();
      return false;
    }
    if (ctrlShift && e.key === "V") {
      e.preventDefault();
      pasteClipboard();
      return false;
    }
    if (ctrlShift && e.key === "F") {
      e.preventDefault();
      openSearch();
      return false;
    }
    if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomBy(1);
      return false;
    }
    if (e.ctrlKey && e.key === "-") {
      e.preventDefault();
      zoomBy(-1);
      return false;
    }
    if (e.ctrlKey && e.key === "0") {
      e.preventDefault();
      resetZoom();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    if (dead) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    invoke("write_session", { id: props.sessionId, data: bytes }).catch(() => {});
  });

  term.onResize(({ cols, rows }) => {
    invoke("resize_session", { id: props.sessionId, cols, rows }).catch(() => {});
  });

  term.onTitleChange((title) => {
    if (title) emit("title-change", title);
  });

  unlisteners.push(
    await listen<{ id: number; data: string }>("terminal-output", (e) => {
      if (e.payload.id !== props.sessionId || !term) return;
      // The backend sends base64 (compact vs. JSON number[]).
      const bin = atob(e.payload.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    }),
  );

  unlisteners.push(
    await listen<{ id: number; code: number | null }>("terminal-exit", (e) => {
      if (e.payload.id !== props.sessionId || !term) return;
      dead = true;
      const code = e.payload.code;
      term.write(`\r\n\x1b[90m[process exited with code ${code ?? "?"}]\x1b[0m\r\n`);
      emit("exit", code);
    }),
  );

  // Windows terminal convention: right-click copies the selection if there is
  // one, otherwise pastes the clipboard.
  host.value.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (term?.hasSelection()) {
      copySelection();
    } else {
      pasteClipboard();
    }
  });

  resizeObserver = new ResizeObserver(() => fit());
  resizeObserver.observe(host.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  for (const un of unlisteners) un();
  unlisteners = [];
  term?.dispose();
  term = null;
  fitAddon = null;
  searchAddon = null;
});
</script>

<template>
  <div ref="host" class="terminal-host">
    <div v-if="searchVisible" class="search-bar" @keydown.esc.prevent="closeSearch">
      <input
        ref="searchInput"
        v-model="searchTerm"
        placeholder="搜索 / Search"
        spellcheck="false"
        @input="find(true)"
        @keydown.enter.prevent="find(true)"
        @keydown.shift.enter.prevent="find(false)"
      />
      <button title="上一个 / Previous (Shift+Enter)" @click="find(false)">↑</button>
      <button title="下一个 / Next (Enter)" @click="find(true)">↓</button>
      <button title="关闭 / Close (Esc)" @click="closeSearch">×</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-host {
  position: relative;
  width: 100%;
  height: 100%;
}

.terminal-host :deep(.xterm) {
  height: 100%;
}

.search-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px;
  background: var(--tabbar-bg, #2d2d2d);
  border: 1px solid var(--border, #3c3c3c);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.search-bar input {
  width: 180px;
  padding: 4px 8px;
  border: 1px solid var(--border, #3c3c3c);
  border-radius: 4px;
  background: var(--bg, #1e1e1e);
  color: var(--fg, #d4d4d4);
  font-size: 12px;
  outline: none;
}

.search-bar input:focus {
  border-color: #396cd8;
}

.search-bar button {
  border: none;
  background: transparent;
  color: var(--fg, #cccccc);
  font-size: 13px;
  padding: 3px 7px;
  border-radius: 4px;
  cursor: pointer;
}

.search-bar button:hover {
  background: rgba(128, 128, 128, 0.25);
}
</style>
