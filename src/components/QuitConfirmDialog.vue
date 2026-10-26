<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { RenamedTab } from "../lib/close-guard";

const props = defineProps<{
  tabs: RenamedTab[];
  activeId: number | null;
}>();

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "confirm"): void;
  (e: "jump", id: number): void;
}>();

const dialogEl = ref<HTMLElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);

/** Esc 取消；Tab 在弹窗内循环，避免焦点跑到背后的终端。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("cancel");
    return;
  }
  if (e.key !== "Tab") return;

  const root = dialogEl.value;
  if (!root) return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>("button:not([disabled])"),
  );
  if (items.length === 0) return;

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown, true);
  await nextTick();
  // 默认焦点落在「取消」上：误按 Enter 不会退出。
  cancelBtn.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <div class="quit-overlay" @click.self="emit('cancel')">
    <div
      ref="dialogEl"
      class="quit-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quit-title"
      aria-describedby="quit-desc"
    >
      <h2 id="quit-title" class="quit-title">退出确认</h2>
      <p id="quit-desc" class="quit-text">以下标签页使用了自定义标题：</p>

      <ul class="quit-list">
        <li v-for="tab in props.tabs" :key="tab.id">
          <button
            class="quit-row"
            :class="{ active: tab.id === props.activeId }"
            :aria-label="`${tab.title}（${tab.shellTitle}）`"
            @click="emit('jump', tab.id)"
          >
            <span class="quit-row-title">{{ tab.title }}</span>
            <span class="quit-row-sub">{{ tab.shellTitle }}</span>
          </button>
        </li>
      </ul>

      <p class="quit-note">退出会结束所有终端会话。</p>

      <div class="quit-actions">
        <button ref="cancelBtn" class="quit-btn" @click="emit('cancel')">取消</button>
        <button class="quit-btn danger" @click="emit('confirm')">仍要退出</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quit-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}

.quit-dialog {
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  padding: 18px 20px 16px;
  font-size: 15px;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

.quit-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
}

.quit-text {
  margin: 0 0 10px;
  color: var(--fg-dim);
}

.quit-list {
  margin: 0;
  padding: 0;
  overflow-y: auto;
  max-height: 260px;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.quit-list li + li {
  border-top: 1px solid var(--border);
}

.quit-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 12px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
}

.quit-row:hover,
.quit-row:focus-visible {
  background: rgba(128, 128, 128, 0.18);
  outline: none;
}

.quit-row.active {
  box-shadow: inset 3px 0 0 var(--fg-dim);
}

.quit-row-title {
  font-weight: 550;
}

.quit-row-sub {
  font-size: 0.8em;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quit-note {
  margin: 10px 0 14px;
  font-size: 0.85em;
  color: var(--fg-dim);
}

.quit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.quit-btn {
  padding: 6px 16px;
  font: inherit;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.quit-btn:hover,
.quit-btn:focus-visible {
  background: rgba(128, 128, 128, 0.2);
  outline: none;
}

.quit-btn.danger {
  color: #fff;
  background: #b3261e;
  border-color: #b3261e;
}

.quit-btn.danger:hover,
.quit-btn.danger:focus-visible {
  background: #9a201a;
}
</style>
