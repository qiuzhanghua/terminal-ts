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
2. **字体 / Font**：xterm 用 canvas 渲染器，而 WebKit 的 canvas **只认 fontFamily 链里第一个能被解析的字体**——链首若未安装，canvas 直接回退成比例默认字体，整条链作废（会渲染成比例字体/无连字）。所以链必须**从本机真实已安装的字体开始**：`src/lib/fonts.ts` 用哨兵字体探测（`14px "X", monospace` vs `14px "__missing__", monospace` 对比宽度）挑出已安装的 Nerd/连字字体置于链首，系统等宽（Menlo，macOS 必有）永远作为兜底。**阈值必须低（0.1）**：JetBrains Mono 与 Menlo 字宽差仅 ~0.4px，阈值 0.5 会漏判。**不要用 `serif`/`sans`/单独的 `monospace` 作探测基准**：未知字体会落回默认字体而非该泛型（serif 会误判），而 `monospace` 在 macOS 就是 Menlo 会互相抵消。oh-my-posh 提示符使用私有区图标（U+E0B0–U+E0B6、U+EA83、U+F00C），中文字体（微软雅黑/宋体）会把私有区码位映射成汉字字形 → 显示为 `瞵間` 类乱码。字体链顺序：已装的 Nerd Font → 已装的连字等宽 → Menlo 等系统等宽 → CJK。
   xterm uses the canvas renderer, and WebKit's canvas **only honors the FIRST family in the chain that it can resolve**: if the leading family is missing, canvas falls back to a proportional default and the rest is ignored (proportional glyphs / no ligatures). So the chain MUST start from a truly-installed font. `src/lib/fonts.ts` detects installed Nerd/ligature fonts via a sentinel probe (`"X", monospace` vs `"__missing__", monospace` width) and leads with the best one; system monospace (Menlo, always present on macOS) is a guaranteed fallback. Use a LOW threshold (0.1): JetBrains Mono differs from Menlo by only ~0.4px, so 0.5 misses it. Do NOT probe against `serif`/`sans`/plain `monospace` (unknown families fall to the default font, and `monospace` is Menlo on macOS which cancels out). oh-my-posh prompts use PUA icons (U+E0B0–U+E0B6, U+EA83, U+F00C); CJK fonts (YaHei/SimSun) map those codepoints to CJK ideographs → mojibake like `瞵間`. Chain order: installed Nerd Font → installed ligature mono → system mono (Menlo) → CJK.
3. **pwsh 启动噪音 / pwsh startup noise**：`spawn_shell` 给 pwsh 加了 `-NoLogo`、`-NoProfileLoadTime` 与 `POWERSHELL_UPDATECHECK=Off`（powershell 5.1 只加 `-NoLogo`，它不识别 `-NoProfileLoadTime`）。新增启动参数时注意 5.1 兼容性。
   `spawn_shell` adds `-NoLogo`, `-NoProfileLoadTime` and `POWERSHELL_UPDATECHECK=Off` for pwsh (PS 5.1 gets only `-NoLogo`; it doesn't recognize `-NoProfileLoadTime`). Keep 5.1 compatibility when adding launch args.
4. **会话生命周期 / Session lifecycle**：读线程 EOF 后用 `try_wait()` 轮询取退出码再发 `terminal-exit`，避免长时间持锁阻塞 `kill_session`；窗口销毁 / 应用退出时 `kill_all_sessions` 清理子进程。
   After EOF the reader thread polls `try_wait()` for the exit code before emitting `terminal-exit`, so `kill_session` is never blocked on a held lock; `kill_all_sessions` cleans up children on window destroy / app exit.
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
