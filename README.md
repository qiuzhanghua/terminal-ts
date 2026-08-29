# Terminal (Tauri)

用 [Tauri 2](https://tauri.app) 实现的桌面终端模拟器。
A desktop terminal emulator built with [Tauri 2](https://tauri.app).

## 功能 / Features

- **Shell 自动检测 / Automatic shell detection**（与原项目一致 / same as the original project）：
  - Windows: 优先级 `pwsh` → `powershell` → `cmd` (priority order)
  - 非 Windows: 读取 `$SHELL` 环境变量，默认 `/bin/bash` / reads `$SHELL`, falls back to `/bin/bash`
- **真实 PTY 会话 / Real PTY sessions**：Windows 使用 ConPTY，其他平台使用 Unix PTY，交互式程序（vim、htop 等）完整可用 / ConPTY on Windows, Unix PTY elsewhere; interactive programs (vim, htop, …) work fully
- **支持管道、重定向 / Pipes & redirection**：`ls -la | grep rust`、`echo hello > file.txt`、`cat < input.txt`
- **多标签页 / Multiple tabs**：新建（＋ / Ctrl+Shift+T）、关闭（× / 鼠标中键 / Ctrl+Shift+W）、切换（Ctrl+Tab / Ctrl+PageUp·PageDown）/ new (＋ / Ctrl+Shift+T), close (× / middle-click / Ctrl+Shift+W), switch (Ctrl+Tab / Ctrl+PageUp·PageDown)
- **复制粘贴 / Copy & paste**：Ctrl+Shift+C 复制选中、Ctrl+Shift+V 粘贴、右键（有选中→复制，无选中→粘贴）/ copy selection (Ctrl+Shift+C), paste (Ctrl+Shift+V), right-click (copy if selection, else paste)
- **终端内搜索 / In-terminal search**：Ctrl+Shift+F，Enter/Shift+Enter 下一个/上一个，Esc 关闭 / open with Ctrl+Shift+F; Enter / Shift+Enter for next / previous; Esc closes
- **字体缩放 / Font zoom**：Ctrl+= / Ctrl+- 缩放、Ctrl+0 复位 / zoom with Ctrl+= / Ctrl+-, reset with Ctrl+0
- **配置文件 / Config file**：`config.json` 可覆盖 shell、字体、字号、主题等，首次运行自动生成 / `config.json` overrides shell, font, size, theme, etc.; auto-created on first run
- **主题 / Themes**：dark、light、solarized-dark、dracula、tokyo-night 或跟随系统深色模式 / preset themes or follow the OS dark/light mode
- **窗口标题联动 / Window title sync**：shell 通过 OSC 0/2 设置标题时，同步更新窗口标题 / window title follows the shell's OSC 0/2 title
- **单实例 / Single instance**：重复启动时聚焦已有窗口，不新开 / a second launch focuses the existing window instead of duplicating
- **窗口状态记忆 / Window state**：记住窗口位置与大小，重启恢复 / window position and size are remembered across restarts
- **tab 切换保留历史 / Tab history preserved**：切换标签页时终端的命令历史与输出完整保留 / switching tabs keeps each terminal's history intact
- 进程退出后自动关闭该标签页；若为最后一个标签页则关闭窗口 / auto-closes the tab when the shell exits; closes the window when it was the last tab

## 配置 / Configuration

配置文件位于应用配置目录，首次运行自动生成（默认值可直接改）：

- **Windows**: `%APPDATA%\dev.taiji.terminal-ts\config.json`
- **macOS**: `~/Library/Application Support/dev.taiji.terminal-ts/config.json`
- **Linux**: `~/.config/dev.taiji.terminal-ts/config.json`

| 字段 / Field | 类型 | 说明 / Meaning |
|---|---|---|
| `shell` | string \| null | 覆盖 shell 检测（如 `"pwsh"`、`"cmd"`、`"bash"`）；null = 自动检测 |
| `font_size` | number | 字号（默认 14） |
| `font_family` | string \| null | 覆盖运行时字体探测（如 `"JetBrainsMono NFM"`）；null = 自动 |
| `theme` | string | `dark` / `light` / `solarized-dark` / `dracula` / `tokyo-night` / `followSystem` |
| `cursor_blink` | boolean | 光标闪烁（默认 true） |
| `scrollback` | number | 回滚行数（默认 10000） |
| `start_cwd` | string \| null | 新 shell 的起始目录；null = 用户主目录 |

修改后重启应用生效。示例：使用 Tokyo Night 主题 + 16px 字号：
`"theme": "tokyo-night", "font_size": 16`

## 中文 / 图标显示 · Chinese / icon rendering

终端基于 **xterm ≥ 6.0.0**（5.4+ 起只有 DOM 渲染器——canvas 渲染器与 `rendererType` 选项已移除；**6.0.0 修复了 DOM 渲染器不绘制空格背景的问题**，oh-my-posh 的 `空格✓空格` 蓝色段才能正常显示，因此不要降级到 5.5 及更早）。字体链在 `src/lib/fonts.ts` 里用哨兵字体探测（`14px "X", monospace` vs `14px "__missing__", monospace` 的宽度对比，先 `await document.fonts.ready`）挑出本机已安装字体，优先级（最佳在前）：

```
① 带连字的 Nerd Font（JetBrainsMono/FiraCode/CaskaydiaCove Nerd Font，连字 + 图标一个字体搞定）
→ ② 纯连字等宽（JetBrains Mono / Fira Code / Cascadia Code，连字生效，图标回退到后面的 Nerd Font）
→ ③ 纯 Nerd Font（MesloLGM 等，图标保证、无连字）
→ ④ 系统等宽（Menlo）→ CJK（Sarasa Mono SC 优先，中文等宽）→ monospace
```

- **连字字体优先**：只有让 JetBrains Mono / Fira Code / Cascadia 等带 `calt` 连字字形的字体排在链首，`->`、`=>`、`===` 才会渲染成连字；且探测阈值必须低（0.1）——JetBrains Mono 与 Menlo 的字宽差仅 ~0.4px，0.5 会漏判成"不可用"。**不要用 `serif`/`sans`/单独的 `monospace` 作探测基准**：未知字体会落回默认字体而非该泛型（`serif` 会误判），而 `monospace` 在 macOS 就是 Menlo 会互相抵消。
- **Nerd Font 必须放在中文字体之前**：oh-my-posh 等提示符使用 Nerd Font / powerline 私有区图标（U+E0B0–U+E0B6、U+EA83、U+F00C 等）。中文字体（微软雅黑/宋体/PingFang）会把私有区码位错误映射成汉字字形，导致显示为 `瞵間` 类乱码；Nerd Font 优先可保证图标正确渲染。
  **Nerd Font must come before CJK fonts**: prompts like oh-my-posh use private-use-area (PUA) glyphs from Nerd Font / powerline (U+E0B0–U+E0B6, U+EA83, U+F00C, …). CJK fonts (Microsoft YaHei/SimSun/PingFang) mis-map those PUA codepoints to CJK ideographs, producing mojibake like `瞵間`; putting the Nerd Font first renders the icons correctly.
- **CJK 等宽优先用更纱黑体（Sarasa Mono SC / Sarasa Term SC）**：Sarasa 的西文来自 Iosevka、中文来自思源黑体，Mono/Term 变体把 CJK 字形调整到恰好 2 倍西文宽度，中文在终端里保持等宽网格。其 PUA 图标只有部分 powerline 箭头（无完整 Nerd 集），因此排在 Nerd Font 之后——图标仍由 Nerd Font 渲染，中文回退到 Sarasa。字体链已内置，安装后自动生效；未安装时自动回退到系统 CJK 字体（PingFang SC / 微软雅黑），Linux 尾部兜底文泉驿正黑（WenQuanYi Zen Hei）与 Droid Sans Fallback（麒麟/老系统预装）。
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

另：pwsh 启动参数含 `-NoExit -Command "$PSStyle.OutputRendering='Ansi'"`——ConPTY 下默认 `Host` 模式会剥掉提示符的 ANSI 颜色，强制 `Ansi` 保证 oh-my-posh 段正常着色。/ pwsh is launched with `-NoExit -Command "$PSStyle.OutputRendering='Ansi'"` — under ConPTY the default `Host` mode strips ANSI from the prompt; forcing `Ansi` keeps oh-my-posh segments colored.

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
npm test                      # 前端测试：vitest / frontend unit tests
cd src-tauri && cargo build   # 后端：Rust / backend
cd src-tauri && cargo test    # 后端测试 / backend unit tests
cd src-tauri && cargo clippy  # Lint
cd src-tauri && cargo fmt --check
```

## 技术栈 / Tech stack

- 后端 / Backend：Rust + Tauri 2 + `portable-pty`（会话管理、事件流 / sessions & event streaming）+ `tauri-plugin-single-instance` / `window-state` / `clipboard-manager`
- 前端 / Frontend：Vue 3 + TypeScript + xterm.js 6（`@xterm/xterm` + `@xterm/addon-fit` / `addon-search` / `addon-ligatures`）+ Vite 8（Rolldown）
- CI：GitHub Actions（`.github/workflows/ci.yml`，前端 build + vitest；后端双平台 fmt/clippy/test）

## 架构 / Architecture

```
前端 / Frontend (WebView)
  └─ App.vue: 标签页管理（新建/关闭/切换 + 窗口标题联动）/ tab management + window title sync
      └─ TerminalView.vue: xterm.js 实例 / xterm.js instance
           │  invoke: spawn_shell / write_session / resize_session / kill_session / get_config / save_config
           ▼
后端 / Backend (Rust)
  ├─ SessionManager: session id → PTY 会话 / session id → PTY session
  ├─ 读线程 / reader thread: shell 输出 → emit "terminal-output"(base64) / "terminal-exit"
  ├─ 退出监听 / exit watcher: 子进程退出 → 关闭 ConPTY → 触发 terminal-exit
  └─ 插件 / plugins: single-instance、window-state、clipboard-manager
```
