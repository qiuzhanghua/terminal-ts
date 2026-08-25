<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalView from "./components/TerminalView.vue";

interface Tab {
  id: number;
  title: string;
  dead: boolean;
}

const tabs = ref<Tab[]>([]);
const activeId = ref<number | null>(null);
const viewRefs = ref<Record<number, InstanceType<typeof TerminalView> | null>>({});

const appWindow = getCurrentWindow();

function setViewRef(id: number, el: InstanceType<typeof TerminalView> | null) {
  viewRefs.value[id] = el;
}

async function addTab(): Promise<void> {
  const id = await invoke<number>("spawn_shell");
  tabs.value.push({ id, title: "Terminal", dead: false });
  await activate(id);
}

async function activate(id: number): Promise<void> {
  activeId.value = id;
  await nextTick();
  viewRefs.value[id]?.fit();
  const tab = tabs.value.find((t) => t.id === id);
  if (tab && !tab.dead) {
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
    await appWindow.close();
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
  const tab = tabs.value.find((t) => t.id === id);
  if (tab) tab.dead = true;
}

onMounted(() => {
  addTab();
});
</script>

<template>
  <div class="app">
    <div class="tabbar">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeId, dead: tab.dead }"
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

.tab.dead .tab-title::after {
  content: " ⚠";
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
