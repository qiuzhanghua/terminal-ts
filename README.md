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
- 进程退出后自动关闭该标签页；若为最后一个标签页则关闭窗口 / auto-closes the tab when the shell exits; closes the window when it was the last tab

## 中文 / 图标显示 · Chinese / icon rendering

终端字体链由 xterm 的 **canvas 渲染器**绘制（`src/lib/fonts.ts`）。WebKit 的 canvas **只认链里第一个能解析的字体**——链首若未安装，canvas 直接回退成比例默认字体、整条链作废（字母错位/2 倍宽/无连字）；Blink（Windows WebView2）则按字形回退，链后部的字体仍会参与（图标、中文）。因此链**必须从本机真实已安装的字体开始**：用哨兵字体探测（`14px "X", monospace` vs `14px "__missing__", monospace` 的宽度对比）挑出已安装字体，优先级（最佳在前）：

```
① 带连字的 Nerd Font（JetBrainsMono/FiraCode/CaskaydiaCove Nerd Font，连字 + 图标一个字体搞定）
→ ② 纯连字等宽（JetBrains Mono / Fira Code / Cascadia Code，连字生效，图标回退到后面的 Nerd Font）
→ ③ 纯 Nerd Font（MesloLGM 等，图标保证、无连字）
→ ④ 系统等宽（Menlo）→ CJK → monospace
```

- **连字字体优先**：只有让 JetBrains Mono / Fira Code / Cascadia 等带 `calt` 连字字形的字体排在链首，`->`、`=>`、`===` 才会渲染成连字；且探测阈值必须低（0.1）——JetBrains Mono 与 Menlo 的字宽差仅 ~0.4px，0.5 会漏判成"不可用"。**不要用 `serif`/`sans`/单独的 `monospace` 作探测基准**：未知字体会落回默认字体而非该泛型（`serif` 会误判），而 `monospace` 在 macOS 就是 Menlo 会互相抵消。
- **Nerd Font 必须放在中文字体之前**：oh-my-posh 等提示符使用 Nerd Font / powerline 私有区图标（U+E0B0–U+E0B6、U+EA83、U+F00C 等）。中文字体（微软雅黑/宋体/PingFang）会把私有区码位错误映射成汉字字形，导致显示为 `瞵間` 类乱码；Nerd Font 优先可保证图标正确渲染。
  **Nerd Font must come before CJK fonts**: prompts like oh-my-posh use private-use-area (PUA) glyphs from Nerd Font / powerline (U+E0B0–U+E0B6, U+EA83, U+F00C, …). CJK fonts (Microsoft YaHei/SimSun/PingFang) mis-map those PUA codepoints to CJK ideographs, producing mojibake like `瞵間`; putting the Nerd Font first renders the icons correctly.
- **macOS 下安装 Nerd Font**（Homebrew 已合并 cask-fonts 仓库，直接安装即可）/ Install a Nerd Font on macOS:
  ```bash
  brew install --cask font-meslo-lg-nerd-font      # 推荐 / recommended（与 Windows 一致）
  # 其他可选 / alternatives: font-jetbrains-mono-nerd-font, font-fira-code-nerd-font, font-hack-nerd-font
  ```
  未安装任何 Nerd Font 时，程序会自动降级到已装的等宽字体（如 JetBrains Mono / Menlo），但 oh-my-posh 图标可能显示为方块。
- **连字 / Ligatures**（`@xterm/addon-ligatures`）：JetBrains Mono / Fira Code 等带 `calt` 连字字形的字体可渲染 `->`、`=>`、`===` 等连字。Tauri WebView 无 Local Font Access API，插件走 fallback 匹配；无连字字形的字体（Menlo 等）原样显示，不受影响。
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
