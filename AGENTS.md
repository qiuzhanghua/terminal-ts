# AGENTS.md

本文件面向在此仓库工作的 AI 代理，说明项目结构、常用命令与关键实现要点。
This file is for AI agents working in this repository: project structure, common commands and key implementation notes.

## 项目概览 / Project overview

Tauri 2 桌面终端模拟器（复刻 `../terminal` 的功能并增强）：Rust 后端通过 `portable-pty` 管理真实 PTY（Windows ConPTY）shell 会话，前端在 WebView 中用 Vue 3 + TypeScript + xterm.js 渲染。
A Tauri 2 desktop terminal emulator (a recreation of `../terminal` with enhancements): the Rust backend manages real PTY (Windows ConPTY) shell sessions via `portable-pty`; the frontend renders in a WebView with Vue 3 + TypeScript + xterm.js.

## 常用命令 / Common commands

- 运行（开发）/ Run (dev)：`npm run tauri dev`
- 前端构建 / Frontend build：`npm run build`（`vue-tsc --noEmit && vite build`，产物在 `dist/` / output to `dist/`）
- 后端构建 / Backend build：`cd src-tauri && cargo build`
- Lint：`cd src-tauri && cargo clippy`
- 打包 / Package：`npm run tauri build`
- 安装依赖 / Install deps：`npm install`（受限沙箱中若 esbuild postinstall 被拦，可用 `--ignore-scripts` / in a restricted sandbox, use `--ignore-scripts` if esbuild's postinstall is blocked）

## 架构 / Architecture

- `src/App.vue`：标签页管理（新建/关闭/切换 + 窗口标题联动）/ tab management (new/close/switch + window title sync)
- `src/components/TerminalView.vue`：xterm.js 实例 / xterm.js instance；`defineExpose({ fit })` 供切换标签后重新适配尺寸 / exposes `fit()` for re-fitting after tab switches
- `src-tauri/src/lib.rs`：`SessionManager`（session id → PTY 会话 / sessions）、读线程转发 `terminal-output` / `terminal-exit` 事件 / reader thread forwards events；命令 / commands `spawn_shell` / `write_session` / `resize_session` / `kill_session`
- `src-tauri/capabilities/default.json`：权限 / permissions（`core:default` + `core:window:allow-set-title`）

## 关键实现要点（改动前必读）/ Key implementation notes (read before changing code)

1. **编码 / Encoding**：ConPTY 输入/输出均为 UTF-8，全链路字节透传。前端 `TextEncoder` 编码输入、`new Uint8Array` + `term.write` 解码输出；**不要**在 Rust/JS 层做 GBK 等其他编码转换。
   ConPTY I/O is UTF-8; the whole pipeline passes raw bytes. The frontend encodes input with `TextEncoder` and decodes output via `new Uint8Array` + `term.write`; **do not** add GBK or other transcoding in the Rust/JS layer.
2. **字体与渲染 / Font & renderer**：xterm 5.4+ / 6.x **只有 DOM 渲染器**（canvas 渲染器已移除，`rendererType` 选项不存在；`@xterm/addon-ligatures` 的 joiner 是 DOM 专属，二者天然共存）。**xterm 6.0.0 修复了 DOM 渲染器不绘制空格背景的问题**（5.5 及更早：空格无背景 → oh-my-posh 的 `空格✓空格` 蓝色段显示成黑色 → 保持 xterm ≥ 6.0.0）。字体链（DOM 渲染器按字形回退，能力更强）：`src/lib/fonts.ts` 用哨兵字体探测（`14px "X", monospace` vs `14px "__missing__", monospace` 对比宽度）挑出已安装字体，并在探测前 `await document.fonts.ready`（过早探测会全部误判为不可用 → 链首落到 Windows 上没有的 Menlo → 比例字体）。**优先级（最佳在前）**：①带连字的 Nerd Font（JetBrainsMono NF/NFM、FiraCode、CaskaydiaCove——Nerd Fonts v3 用 `NF`/`NFM` 命名，旧名 `Nerd Font` 也在列表里）→ ②纯连字等宽 → ③纯 Nerd Font → ④系统等宽（Consolas 在前，macOS 上 Menlo）→ CJK。**阈值必须低（0.1）**。oh-my-posh 私有区图标（U+E0B0–U+E0B6、U+EA83、U+F00C）必须落在 Nerd Font 上，否则中文字体会把私有区码位映射成汉字（`瞵間`）。
   xterm 5.4+/6.x has **only the DOM renderer** (canvas renderer removed; no `rendererType` option; the ligatures joiner is DOM-only, so both coexist). **xterm 6.0.0 fixed the DOM renderer not painting backgrounds on space characters** (≤5.5: spaces get no bg → oh-my-posh's space-padded segments render black → keep xterm ≥ 6.0.0). Font chain: `src/lib/fonts.ts` probes installed fonts via a sentinel width comparison, awaiting `document.fonts.ready` first (probing too early mis-detects everything → the chain leads with Menlo, absent on Windows → proportional). Preference: ① Nerd-patched ligature fonts (JetBrainsMono NF/NFM — Nerd Fonts v3 naming — plus old `Nerd Font` spellings) → ② plain ligature monospaces → ③ plain Nerd Fonts → ④ system mono (Consolas first; Menlo on macOS) → CJK. LOW threshold (0.1). oh-my-posh PUA icons must resolve to a Nerd Font or CJK fonts map them to ideographs (`瞵間`).
3. **pwsh 启动参数 / pwsh launch args**：`spawn_shell` 给 pwsh 加了 `-NoLogo`、`-NoProfileLoadTime`、`-NoExit -Command "$PSStyle.OutputRendering='Ansi'"` 与 `POWERSHELL_UPDATECHECK=Off`。**`OutputRendering='Ansi'` 必须保留**：ConPTY 下 pwsh 的 `Host` 模式会把第一个提示符的 ANSI 颜色剥掉（oh-my-posh 段全变无色），强制 `Ansi` 后才有颜色（已在 ConPTY 实测验证）。powershell 5.1 只加 `-NoLogo`（无 `$PSStyle`、不识别 `-NoProfileLoadTime`）。新增启动参数时注意 5.1 兼容性。
   `spawn_shell` launches pwsh with `-NoLogo`, `-NoProfileLoadTime`, `-NoExit -Command "$PSStyle.OutputRendering='Ansi'"` and `POWERSHELL_UPDATECHECK=Off`. **Keep `OutputRendering='Ansi'`**: under ConPTY pwsh's `Host` mode strips ANSI from the FIRST prompt (oh-my-posh segments render colorless); forcing `Ansi` restores colors (verified over ConPTY). PS 5.1 gets only `-NoLogo` (no `$PSStyle`, no `-NoProfileLoadTime`). Keep 5.1 compatibility when adding launch args.
4. **会话生命周期 / Session lifecycle**：每个会话有两个线程——读线程把 PTY 输出转发为 `terminal-output`，EOF 后轮询 `try_wait()` 取退出码再发 `terminal-exit`；**退出监视线程**每 100ms 轮询 `try_wait()`，子进程退出后从会话表移除该 session（drop master 关闭 ConPTY）——**不能只依赖读线程的 EOF**：ConPTY 在客户端退出而 master 仍打开时不会给读端 EOF，读线程会永久阻塞、`terminal-exit` 永远不发。窗口销毁 / 应用退出时 `kill_all_sessions` 清理子进程。
   Each session has two threads: the reader forwards PTY output as `terminal-output` and emits `terminal-exit` (with the exit code polled via `try_wait()`) after EOF; an **exit watcher** polls `try_wait()` every 100ms and removes the session from the map when the child exits, dropping the master to close the ConPTY. Do NOT rely on read-EOF alone: ConPTY does not EOF the reader while the master is open after the client exits, so the reader would block forever and `terminal-exit` would never fire. `kill_all_sessions` cleans up children on window destroy / app exit.
5. **事件负载 / Event payload**：`terminal-output` 的 `data` 是 `Vec<u8>`，经 JSON 序列化为 number[]，前端用 `new Uint8Array` 还原；改动协议时保持字节透明。
   `terminal-output.data` is `Vec<u8>`, serialized as a JSON number[] and restored with `new Uint8Array` on the frontend; keep the protocol byte-transparent when changing it.
6. **`allowProposedApi: true` 必开**：`LigaturesAddon` 通过 `registerCharacterJoiner`（xterm 标记为 EXPERIMENTAL/proposed API）实现连字。不开此选项时 `loadAddon` 会抛 `You must set the allowProposedApi option to true`，且该异常发生在 `onMounted` 中途 → 后面所有 `listen()` 都不执行 → 终端无输出、输入无回显（症状像后端坏了）。若移除连字插件，此选项可一并去掉。
   `allowProposedApi: true` is required: `LigaturesAddon` uses `registerCharacterJoiner` (marked EXPERIMENTAL/proposed in xterm). Without it `loadAddon` throws mid-`onMounted`, so the `listen()` calls never run → no output, no input echo (looks like a broken backend). Safe to drop the flag if the addon is removed.

## 注意事项 / Notes

- 前端改动后需 `npm run build` 再打包；`npm run tauri dev` 有 HMR，但 xterm 构造函数参数（如 `fontFamily`）改动建议重启应用。
  Rebuild with `npm run build` after frontend changes; `npm run tauri dev` has HMR, but restart the app after changing xterm constructor options (e.g. `fontFamily`).
- 修改 `tauri.conf.json` / capabilities 后需重新编译后端。
  Rebuild the backend after changing `tauri.conf.json` / capabilities.
- 事件名与命令名是前后端约定，改动需同步 `TerminalView.vue` 与 `lib.rs`。
  Event and command names are a frontend/backend contract; keep `TerminalView.vue` and `lib.rs` in sync.
