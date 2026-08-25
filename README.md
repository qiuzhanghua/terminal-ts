# Terminal (Tauri)

用 [Tauri 2](https://tauri.app) 实现的桌面终端模拟器。
A desktop terminal emulator built with [Tauri 2](https://tauri.app).

## 功能 / Features

- **Shell 自动检测 / Automatic shell detection**（与原项目一致 / same as the original project）：
  - Windows: 优先级 `pwsh` → `powershell` → `cmd` (priority order)
  - 非 Windows: 读取 `$SHELL` 环境变量，默认 `/bin/bash` / reads `$SHELL`, falls back to `/bin/bash`
- **真实 PTY 会话 / Real PTY sessions**：Windows 使用 ConPTY，其他平台使用 Unix PTY，交互式程序（vim、htop 等）完整可用 / ConPTY on Windows, Unix PTY elsewhere; interactive programs (vim, htop, …) work fully
- **支持管道、重定向 / Pipes & redirection**：`ls -la | grep rust`、`echo hello > file.txt`、`cat < input.txt`
- **多标签页 / Multiple tabs**：新建（＋）、关闭（× / 鼠标中键）、切换 / new (＋), close (× / middle-click), switch
- **窗口标题联动 / Window title sync**：shell 通过 OSC 0/2 设置标题时，同步更新窗口标题 / window title follows the shell's OSC 0/2 title
- 进程退出后显示退出码，标签页标记为已结束 / shows the exit code after a process exits and marks the tab as ended

## 中文 / 图标显示 · Chinese / icon rendering

终端字体链 / Terminal font chain（`src/components/TerminalView.vue`）：

```
"MesloLGM Nerd Font Mono" → "Cascadia Mono" → "Consolas" → "Microsoft YaHei" → "Noto Sans SC" → "monospace"
```

- **Nerd Font 必须放在中文字体之前**：oh-my-posh 等提示符使用 Nerd Font / powerline 私有区图标（U+E0B0–U+E0B6、U+EA83、U+F00C 等）。中文字体（微软雅黑/宋体）会把私有区码位错误映射成汉字字形，导致显示为 `瞵間` 类乱码；Nerd Font 优先可保证图标正确渲染。
  **Nerd Font must come before CJK fonts**: prompts like oh-my-posh use private-use-area (PUA) glyphs from Nerd Font / powerline (U+E0B0–U+E0B6, U+EA83, U+F00C, …). CJK fonts (Microsoft YaHei/SimSun) mis-map those PUA codepoints to CJK ideographs, producing mojibake like `瞵間`; putting the Nerd Font first renders the icons correctly.
- **编码管道为纯 UTF-8 字节透传**（ConPTY 输入/输出本身是 UTF-8），不要在 Rust / JS 层做 GBK 等转码。
  **The pipeline is raw UTF-8 bytes end to end** (ConPTY I/O is UTF-8 already); do not add GBK or other transcoding in the Rust/JS layer.

## 启动横幅 / Startup banner

pwsh 启动时的版本横幅、更新提示、profile 加载耗时提示已在 `spawn_shell`（`src-tauri/src/lib.rs`）中抑制。
The pwsh version banner, update notice and profile-load-time message are suppressed in `spawn_shell` (`src-tauri/src/lib.rs`):

| 提示内容 / Message | 抑制方式 / How to suppress |
|---|---|
| `PowerShell 7.6.4`（版本横幅 / version banner） | `-NoLogo` |
| `A new PowerShell stable release is available...`（更新提示 / update notice） | 环境变量 `POWERSHELL_UPDATECHECK=Off` |
| `Loading personal and system profiles took Xms.`（加载耗时 / load time） | `-NoProfileLoadTime`（仅 pwsh，powershell 5.1 不识别 / pwsh only; PS 5.1 doesn't recognize it） |

## 运行（开发）/ Run (dev)

```bash
npm install
npm run tauri dev
```

## 构建 / Build

```bash
npm run tauri build
```

## 单独构建/检查 / Build & check separately

```bash
npm run build                 # 前端：vue-tsc + vite build（产物在 dist/）/ frontend → dist/
cd src-tauri && cargo build   # 后端：Rust / backend
cd src-tauri && cargo clippy  # Lint
```

## 技术栈 / Tech stack

- 后端 / Backend：Rust + Tauri 2 + `portable-pty`（会话管理、事件流 / sessions & event streaming）
- 前端 / Frontend：Vue 3 + TypeScript + xterm.js（`@xterm/xterm` + `@xterm/addon-fit`）

## 架构 / Architecture

```
前端 / Frontend (WebView)
  └─ App.vue: 标签页管理（新建/关闭/切换 + 窗口标题联动）/ tab management + window title sync
      └─ TerminalView.vue: xterm.js 实例 / xterm.js instance
           │  invoke: spawn_shell / write_session / resize_session / kill_session
           ▼
后端 / Backend (Rust)
  ├─ SessionManager: session id → PTY 会话 / session id → PTY session
  ├─ 读线程 / reader thread: shell 输出 → emit "terminal-output" / "terminal-exit"
  └─ 命令 / commands: 写入 stdin、调整 PTY 尺寸、结束会话 / write stdin, resize PTY, kill session
```
