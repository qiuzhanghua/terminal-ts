<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalView from "./components/TerminalView.vue";
import { loadConfig, type AppConfig } from "./lib/config";
import { resolveTheme, isLightTheme } from "./lib/themes";

interface Tab {
  id: number;
  title: string;
}

const tabs = ref<Tab[]>([]);
const activeId = ref<number | null>(null);
const viewRefs = ref<Record<number, InstanceType<typeof TerminalView> | null>>({});

const appWindow = getCurrentWindow();

// Resolved from config.json on startup (theme preset + followSystem).
const cfg = ref<AppConfig | null>(null);
const resolvedTheme = ref<ReturnType<typeof resolveTheme> | null>(null);
const uiLight = ref(false);

function setViewRef(id: number, el: InstanceType<typeof TerminalView> | null) {
  viewRefs.value[id] = el;
}

async function addTab(): Promise<void> {
  const id = await invoke<number>("spawn_shell");
  tabs.value.push({ id, title: "Terminal" });
  await activate(id);
}

async function activate(id: number): Promise<void> {
  activeId.value = id;
  await nextTick();
  viewRefs.value[id]?.fit();
  viewRefs.value[id]?.focus();
  const tab = tabs.value.find((t) => t.id === id);
  if (tab) {
    await appWindow.setTitle(`${tab.title} — Terminal`);
  }
}

async function closeTab(id: number): Promise<void> {
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.value.splice(idx, 1);
  delete viewRefs.value[id];
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
  tab.title = title;
  if (activeId.value === id) {
    appWindow.setTitle(`${title} — Terminal`);
  }
}

function onExit(id: number): void {
  // The shell in this tab exited (e.g. user typed `exit`): close the tab;
  // when it was the last tab the whole window closes.
  closeTab(id);
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
  }
}

onMounted(async () => {
  // Load user configuration (config.json) and the OS theme preference.
  try {
    const { config } = await loadConfig();
    cfg.value = config;
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
    <div class="tabbar">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeId }"
        :title="tab.title"
        @click="activate(tab.id)"
        @auxclick="(e: MouseEvent) => { if (e.button === 1) closeTab(tab.id); }"
      >
        <span class="tab-title">{{ tab.title }}</span>
        <button class="tab-close" title="关闭标签页" @click.stop="closeTab(tab.id)">×</button>
      </div>
      <button class="tab-add" title="新建标签页" @click="addTab">＋</button>
    </div>
    <div class="terminals">
      <TerminalView
        v-for="tab in tabs"
        :key="tab.id"
        v-show="tab.id === activeId"
        :session-id="tab.id"
        :font-size="cfg?.fontSize ?? 14"
        :font-family="cfg?.fontFamily ?? ''"
        :theme="resolvedTheme ?? undefined"
        :cursor-blink="cfg?.cursorBlink ?? true"
        :scrollback="cfg?.scrollback ?? 10000"
        :ref="(el: any) => setViewRef(tab.id, el)"
        @title-change="(t: string) => onTitleChange(tab.id, t)"
        @exit="() => onExit(tab.id)"
      />
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

.tab-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 14px;
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
  font-size: 16px;
  cursor: pointer;
  padding: 0 10px;
  border-radius: 6px 6px 0 0;
  flex-shrink: 0;
}

.tab-add:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg);
}

.terminals {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
