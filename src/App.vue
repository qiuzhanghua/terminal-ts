<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalView from "./components/TerminalView.vue";
import { loadConfig, type AppConfig } from "./lib/config";
import { resolveTheme, isLightTheme } from "./lib/themes";
import { sessionCwd, spawnShell } from "./lib/session";
import {
  applyAutoTitle,
  displayTitle,
  makeTab,
  normalizeTitle,
  type Tab,
} from "./lib/tab-title";

const tabs = ref<Tab[]>([]);
const activeId = ref<number | null>(null);
const viewRefs = ref<Record<number, InstanceType<typeof TerminalView> | null>>({});

/* ---------- inline rename ---------- */

const editingId = ref<number | null>(null);
const draft = ref("");
let draftEl: HTMLInputElement | null = null;
// IME 组合期间（拼音选词）按 Enter 是确认候选，不是提交。
let composing = false;

function setDraftEl(el: any): void {
  draftEl = (el as HTMLInputElement | null) ?? null;
}

function beginEdit(id: number): void {
  if (editingId.value === id) return;
  if (editingId.value !== null) commitEdit();

  const tab = tabs.value.find((t) => t.id === id);
  if (!tab) return;

  editingId.value = id;
  draft.value = displayTitle(tab);
  nextTick(() => {
    draftEl?.focus();
    draftEl?.select();
  });
}

function commitEdit(): void {
  const id = editingId.value;
  if (id === null) return;

  const raw = draft.value;
  const tab = tabs.value.find((t) => t.id === id);
  editingId.value = null;
  draft.value = "";

  if (tab) {
    tab.customTitle = normalizeTitle(raw, tab.autoTitle);
    if (activeId.value === id) syncWindowTitle();
  }
  // 焦点必须还给 xterm，否则改完名字直接敲命令会丢字符。
  nextTick(() => viewRefs.value[id]?.focus());
}

function cancelEdit(): void {
  const id = editingId.value;
  if (id === null) return;
  editingId.value = null;
  draft.value = "";
  nextTick(() => viewRefs.value[id]?.focus());
}

function onDraftKeydown(e: KeyboardEvent): void {
  if (composing || e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
  }
}

function onCompositionStart(): void {
  composing = true;
}

function onCompositionEnd(): void {
  composing = false;
}

function onTabClick(id: number): void {
  if (editingId.value === id) return; // 正在改名时点击输入框不要抢焦点
  activate(id);
}

function onTabDblClick(e: MouseEvent, id: number): void {
  const target = e.target as HTMLElement | null;
  if (target?.closest(".tab-close")) return;
  beginEdit(id);
}

const appWindow = getCurrentWindow();

// Resolved from config.json on startup (theme preset + followSystem).
const cfg = ref<AppConfig | null>(null);
const resolvedTheme = ref<ReturnType<typeof resolveTheme> | null>(null);
const uiLight = ref(false);

// 字号是 App 级状态：终端与 tab 栏都从它派生，Ctrl+=/- 缩放会同步所有标签页。
const fontSize = ref(20);
const baseFontSize = computed(() => cfg.value?.fontSize ?? 20);
/** tab 栏字号跟终端字号成比例，避免 13px 写死、缩放后比例失衡。 */
const tabFontSize = computed(() =>
  Math.min(48, Math.max(8, Math.round(fontSize.value))),
);
const tabBarHeight = computed(() => Math.max(36, tabFontSize.value + 22));

function setViewRef(id: number, el: InstanceType<typeof TerminalView> | null) {
  viewRefs.value[id] = el;
}

async function addTab(): Promise<void> {
  // Read the active tab's directory *before* spawning: by the time the new tab
  // is activated `activeId` already points at it, so asking afterwards would
  // report the new shell's own cwd and inherit nothing.
  const cwd = await sessionCwd(activeId.value);
  const id = await spawnShell(cwd);
  tabs.value.push(makeTab(id));
  await activate(id);
}

async function activate(id: number): Promise<void> {
  activeId.value = id;
  await nextTick();
  viewRefs.value[id]?.fit();
  viewRefs.value[id]?.focus();
  await syncWindowTitle();
}

/** 窗口标题始终由当前 tab 的显示值派生。 */
async function syncWindowTitle(): Promise<void> {
  const tab = tabs.value.find((t) => t.id === activeId.value);
  if (!tab) return;
  await appWindow.setTitle(`${displayTitle(tab)} — Terminal`);
}

async function closeTab(id: number): Promise<void> {
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.value.splice(idx, 1);
  delete viewRefs.value[id];
  if (editingId.value === id) {
    editingId.value = null;
    draft.value = "";
  }
  if (menu.value?.tabId === id) closeMenu();
  invoke("kill_session", { id }).catch(() => {});
  if (tabs.value.length === 0) {
    try {
      await appWindow.close();
    } catch (e) {
      console.error("failed to close window:", e);
    }
    return;
  }
  if (activeId.value === id) {
    await activate(tabs.value[Math.min(idx, tabs.value.length - 1)].id);
  }
}

function onTitleChange(id: number, title: string): void {
  const tab = tabs.value.find((t) => t.id === id);
  if (!tab) return;
  // OSC 只更新 autoTitle；用户起的名字（customTitle）不受影响。
  Object.assign(tab, applyAutoTitle(tab, title));
  if (activeId.value === id) syncWindowTitle();
}

function onExit(id: number): void {
  // The shell in this tab exited (e.g. user typed `exit`): close the tab;
  // when it was the last tab the whole window closes.
  closeTab(id);
}

/* ---------- tab context menu ---------- */

interface MenuState {
  tabId: number;
  x: number;
  y: number;
}

const menu = ref<MenuState | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuTab = computed(
  () => tabs.value.find((t) => t.id === menu.value?.tabId) ?? null,
);
const menuCanReset = computed(() => menuTab.value?.customTitle != null);

function openMenu(e: MouseEvent, id: number): void {
  e.preventDefault();
  menu.value = { tabId: id, x: e.clientX, y: e.clientY };
  nextTick(() => {
    clampMenu();
    focusMenuItem(0);
  });
  window.addEventListener("pointerdown", onDocPointerDown, true);
  window.addEventListener("keydown", onMenuKeydown, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
}

function closeMenu(): void {
  if (menu.value === null) return;
  menu.value = null;
  window.removeEventListener("pointerdown", onDocPointerDown, true);
  window.removeEventListener("keydown", onMenuKeydown, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
}

function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node | null;
  if (target && menuEl.value?.contains(target)) return;
  closeMenu();
}

/** 靠近窗口边缘时把菜单翻到另一侧，避免被裁掉。 */
function clampMenu(): void {
  const el = menuEl.value;
  const m = menu.value;
  if (!el || !m) return;
  const rect = el.getBoundingClientRect();
  let { x, y } = m;
  if (x + rect.width > window.innerWidth - 4) {
    x = Math.max(4, window.innerWidth - rect.width - 4);
  }
  if (y + rect.height > window.innerHeight - 4) {
    y = Math.max(4, window.innerHeight - rect.height - 4);
  }
  if (x !== m.x || y !== m.y) menu.value = { ...m, x, y };
}

function menuItems(): HTMLButtonElement[] {
  const root = menuEl.value;
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>(".tab-menu-item:not([disabled])"),
  );
}

function focusMenuItem(index: number): void {
  const items = menuItems();
  if (items.length === 0) return;
  const n = ((index % items.length) + items.length) % items.length;
  items[n].focus();
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (menu.value === null) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    if (activeId.value != null) viewRefs.value[activeId.value]?.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = menuItems();
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    focusMenuItem(idx + (e.key === "ArrowDown" ? 1 : -1));
  } else if (e.key === "Tab") {
    closeMenu();
  }
}

function menuRename(): void {
  const id = menu.value?.tabId;
  closeMenu();
  if (id != null) beginEdit(id);
}

function menuResetTitle(): void {
  const id = menu.value?.tabId;
  closeMenu();
  if (id == null) return;
  const tab = tabs.value.find((t) => t.id === id);
  if (!tab) return;
  tab.customTitle = null;
  if (activeId.value === id) syncWindowTitle();
  nextTick(() => viewRefs.value[id]?.focus());
}

function menuCloseTab(): void {
  const id = menu.value?.tabId;
  closeMenu();
  if (id != null) closeTab(id);
}

function tabTooltip(tab: Tab): string {
  return tab.customTitle != null
    ? `${displayTitle(tab)} —— 自定义标题（双击重命名，右键可恢复）`
    : `${displayTitle(tab)}（双击重命名）`;
}

/* ---------- global shortcuts (tab management) ---------- */

function switchTab(dir: number): void {
  const n = tabs.value.length;
  if (n === 0 || activeId.value == null) return;
  const idx = tabs.value.findIndex((t) => t.id === activeId.value);
  if (idx === -1) return;
  activate(tabs.value[(idx + dir + n) % n].id);
}

function onKeydown(e: KeyboardEvent): void {
  // 重命名期间所有全局快捷键让路（否则 Ctrl+Shift+W 会把正在改名的 tab 关掉）
  // 只按编辑态判断：xterm 的输入是隐藏的 <textarea class="xterm-helper-textarea">，
  // 不能因为 target 是 TEXTAREA 就让路，否则所有快捷键（F2、Ctrl+Shift+T…）都会被吞。
  if (editingId.value !== null || menu.value !== null) return;

  if (e.ctrlKey && e.shiftKey && e.key === "T") {
    e.preventDefault();
    addTab();
  } else if (e.ctrlKey && e.shiftKey && e.key === "W") {
    e.preventDefault();
    if (activeId.value != null) closeTab(activeId.value);
  } else if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    switchTab(e.shiftKey ? -1 : 1);
  } else if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    switchTab(e.key === "PageDown" ? 1 : -1);
  } else if (e.key === "F2") {
    e.preventDefault();
    if (activeId.value != null) beginEdit(activeId.value);
  }
}

onMounted(async () => {
  // Load user configuration (config.json) and the OS theme preference.
  try {
    const { config } = await loadConfig();
    cfg.value = config;
    fontSize.value = config.fontSize;
    const systemTheme = await appWindow.theme();
    resolvedTheme.value = resolveTheme(config.theme, systemTheme);
    uiLight.value = isLightTheme(config.theme, systemTheme);
  } catch (e) {
    console.error("failed to load config:", e);
    resolvedTheme.value = resolveTheme("dark", null);
  }

  addTab();
  window.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <div class="app" :data-theme="uiLight ? 'light' : 'dark'">
    <div class="tabbar" :style="{ fontSize: tabFontSize + 'px', height: tabBarHeight + 'px' }">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeId, editing: tab.id === editingId }"
        :title="tab.id === editingId ? '' : tabTooltip(tab)"
        @click="onTabClick(tab.id)"
        @dblclick="onTabDblClick($event, tab.id)"
        @contextmenu="openMenu($event, tab.id)"
        @auxclick="(e: MouseEvent) => { if (e.button === 1) closeTab(tab.id); }"
      >
        <input
          v-if="tab.id === editingId"
          class="tab-input"
          v-model="draft"
          :ref="setDraftEl"
          spellcheck="false"
          autocomplete="off"
          @click.stop
          @dblclick.stop
          @keydown="onDraftKeydown"
          @blur="commitEdit"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
        />
        <span v-else class="tab-title" :class="{ custom: tab.customTitle !== null }">
          {{ displayTitle(tab) }}
        </span>
        <button class="tab-close" title="关闭标签页" @click.stop="closeTab(tab.id)">×</button>
      </div>
      <button class="tab-add" title="新建标签页" @click="addTab()">＋</button>
    </div>
    <div class="terminals">
      <TerminalView
        v-for="tab in tabs"
        :key="tab.id"
        v-show="tab.id === activeId"
        :session-id="tab.id"
        :font-size="fontSize"
        :font-family="cfg?.fontFamily ?? ''"
        :theme="resolvedTheme ?? undefined"
        :cursor-blink="cfg?.cursorBlink ?? true"
        :scrollback="cfg?.scrollback ?? 10000"
        :ref="(el: any) => setViewRef(tab.id, el)"
        @title-change="(t: string) => onTitleChange(tab.id, t)"
        @zoom="fontSize = $event"
        @zoom-reset="fontSize = baseFontSize"
        @exit="() => onExit(tab.id)"
      />
    </div>

    <div
      v-if="menu"
      ref="menuEl"
      class="tab-menu"
      role="menu"
      :style="{
        left: menu.x + 'px',
        top: menu.y + 'px',
        fontSize: tabFontSize + 'px',
      }"
      @contextmenu.prevent
    >
      <button class="tab-menu-item" role="menuitem" @click="menuRename">
        <span>重命名</span><span class="tab-menu-hint">F2</span>
      </button>
      <button
        class="tab-menu-item"
        role="menuitem"
        :disabled="!menuCanReset"
        @click="menuResetTitle"
      >
        <span>恢复自动标题</span>
      </button>
      <div class="tab-menu-sep"></div>
      <button class="tab-menu-item" role="menuitem" @click="menuCloseTab">
        <span>关闭标签页</span><span class="tab-menu-hint">Ctrl+Shift+W</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Light UI chrome when the terminal theme resolves to light. */
.app[data-theme="light"] {
  --bg: #ffffff;
  --tabbar-bg: #f3f3f3;
  --tab-active-bg: #ffffff;
  --tab-inactive-bg: #e8e8e8;
  --border: #d4d4d4;
  --fg: #333333;
  --fg-dim: #6a6a6a;
}

.tabbar {
  display: flex;
  align-items: stretch;
  gap: 4px;
  height: 36px;
  padding: 4px 6px 0;
  background: var(--tabbar-bg);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  scrollbar-width: thin;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 100px;
  max-width: 240px;
  padding: 0 8px 0 12px;
  background: var(--tab-inactive-bg);
  color: var(--fg-dim);
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.tab:hover {
  color: var(--fg);
}

.tab.active {
  background: var(--tab-active-bg);
  color: var(--fg);
}

.tab-title.custom {
  font-style: italic;
  opacity: 0.9;
}

.tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab.editing {
  background: var(--tab-active-bg);
  color: var(--fg);
  box-shadow: inset 0 0 0 1px var(--border);
}

.tab-input {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  font: inherit;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
  user-select: text;
}

.tab-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 1.05em;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  cursor: pointer;
}

.tab-close:hover {
  background: rgba(255, 255, 255, 0.15);
}

.tab-add {
  border: none;
  background: transparent;
  color: var(--fg-dim);
  font-size: 1.2em;
  cursor: pointer;
  padding: 0 10px;
  border-radius: 6px 6px 0 0;
  flex-shrink: 0;
}

.tab-add:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg);
}

.tab-menu {
  position: fixed;
  z-index: 100;
  min-width: 190px;
  padding: 4px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
}

.tab-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.tab-menu-item:hover:not(:disabled),
.tab-menu-item:focus-visible {
  background: rgba(128, 128, 128, 0.22);
  outline: none;
}

.tab-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.tab-menu-hint {
  margin-left: 24px;
  color: var(--fg-dim);
  font-size: 0.85em;
}

.tab-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}

.terminals {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
