<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { ConfirmAction, ConfirmRow } from "../lib/close-guard";

const props = defineProps<{
  rows: ConfirmRow[];
  action: ConfirmAction;
  activeId: number | null;
}>();

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "confirm"): void;
  (e: "jump", id: number): void;
}>();

const dialogEl = ref<HTMLElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);

const isQuit = () => props.action === "quit";

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
  // 默认焦点落在「取消」上：误按 Enter 不会关闭。
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
      <h2 id="quit-title" class="quit-title">
        {{ isQuit() ? "退出确认" : "关闭标签页" }}
      </h2>
      <p id="quit-desc" class="quit-text">
        {{ isQuit() ? "以下标签页有自定义标题或仍在运行进程：" : "这个标签页仍在运行进程：" }}
      </p>

      <ul class="quit-list">
        <li v-for="row in props.rows" :key="row.id">
          <button
            class="quit-row"
            :class="{ active: row.id === props.activeId }"
            :aria-label="`${row.title}（${row.shellTitle}）`"
            @click="emit('jump', row.id)"
          >
            <span class="quit-row-head">
              <span class="quit-row-title">{{ row.title }}</span>
              <span class="quit-badges">
                <span v-if="row.custom" class="quit-badge">自定义标题</span>
                <span v-if="row.foreground" class="quit-badge running">
                  运行中 {{ row.foreground.name }}
                </span>
                <span v-if="row.background.length" class="quit-badge running">
                  后台 {{ row.background.length }} 个进程
                </span>
              </span>
            </span>
            <span class="quit-row-sub">{{ row.shellTitle }}</span>
          </button>
        </li>
      </ul>

      <p class="quit-note">
        {{ isQuit() ? "退出会结束所有终端会话。" : "关闭会结束这个标签页里的进程。" }}
      </p>

      <div class="quit-actions">
        <button ref="cancelBtn" class="quit-btn" @click="emit('cancel')">取消</button>
        <button class="quit-btn danger" @click="emit('confirm')">
          {{ isQuit() ? "仍要退出" : "仍要关闭" }}
        </button>
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
  width: min(560px, calc(100vw - 48px));
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
  gap: 3px;
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

.quit-row-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.quit-row-title {
  font-weight: 550;
}

.quit-badges {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quit-badge {
  padding: 0 6px;
  font-size: 0.72em;
  line-height: 1.6;
  color: var(--fg-dim);
  border: 1px solid var(--border);
  border-radius: 999px;
}

.quit-badge.running {
  color: #e0b341;
  border-color: #a07d1c;
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
