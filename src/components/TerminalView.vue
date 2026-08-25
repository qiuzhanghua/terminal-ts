<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const props = defineProps<{ sessionId: number }>();

const emit = defineEmits<{
  (e: "title-change", title: string): void;
  (e: "exit", code: number | null): void;
}>();

const host = ref<HTMLDivElement | null>(null);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let unlisteners: UnlistenFn[] = [];
let resizeObserver: ResizeObserver | null = null;
let dead = false;

function fit(): void {
  if (!fitAddon || dead) return;
  try {
    fitAddon.fit();
  } catch {
    // element may be hidden (v-show) or not yet laid out; retry on next show
  }
}

defineExpose({ fit });

onMounted(async () => {
  if (!host.value) return;

  term = new Terminal({
    fontFamily:
      '"MesloLGM Nerd Font Mono", "Cascadia Mono", "Consolas", "Microsoft YaHei", "Noto Sans SC", "monospace"',
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#aeafad",
      selectionBackground: "#264f78",
    },
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host.value);
  fit();

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
    await listen<{ id: number; data: number[] }>("terminal-output", (e) => {
      if (e.payload.id !== props.sessionId || !term) return;
      term.write(new Uint8Array(e.payload.data));
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
});
</script>

<template>
  <div ref="host" class="terminal-host"></div>
</template>

<style scoped>
.terminal-host {
  width: 100%;
  height: 100%;
}

.terminal-host :deep(.xterm) {
  height: 100%;
}
</style>
