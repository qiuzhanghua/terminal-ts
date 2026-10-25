/**
 * Tab 标题的纯逻辑：区分「shell 给的」和「用户起的」两个来源。
 *
 * 为什么不只存一个 title：pwsh + oh-my-posh 之类的提示符每个命令都会发一次
 * OSC 0/2（目录、git 分支一变就重发）。如果用户重命名后还让 OSC 覆盖同一个
 * 字段，刚起的名字下一次回车就没了。所以 autoTitle 只由 OSC 写，customTitle
 * 只由用户写，显示值永远是 customTitle ?? autoTitle。
 */

/** 用户自定义标题的最大长度（按 Unicode 码位算，避免 emoji 被截半）。 */
export const MAX_TITLE_CHARS = 64;

export interface Tab {
  id: number;
  /** 来自 shell 的 OSC 0/2；没有收到时是 "Terminal"。 */
  autoTitle: string;
  /** 用户重命名后的标题；null 表示跟随 shell。 */
  customTitle: string | null;
}

export function makeTab(id: number, autoTitle = "Terminal"): Tab {
  return { id, autoTitle, customTitle: null };
}

/** 标签页与窗口标题都应该用这个值。 */
export function displayTitle(tab: Pick<Tab, "autoTitle" | "customTitle">): string {
  return tab.customTitle ?? tab.autoTitle;
}

/**
 * OSC 0/2 到达时的新 Tab 状态：只更新 autoTitle，绝不动 customTitle。
 * 空标题按 xterm 的 onTitleChange 语义忽略（调用方也会先判空）。
 */
export function applyAutoTitle(tab: Tab, incoming: string): Tab {
  if (!incoming) return tab;
  return { ...tab, autoTitle: incoming };
}

/**
 * 把用户输入规整成可存的 customTitle：
 * - 去掉控制字符（含换行、制表符）并 trim；
 * - 超过 MAX_TITLE_CHARS 个码位时截断；
 * - 空串或与 autoTitle 相同 → null（等价于「恢复自动标题」），
 *   避免留下一个看起来自定义、其实没改的状态。
 */
export function normalizeTitle(raw: string, autoTitle: string): string | null {
  const cleaned = [...raw].filter((ch) => !/\p{Cc}/u.test(ch)).join("").trim();
  if (!cleaned) return null;

  const limited = [...cleaned].slice(0, MAX_TITLE_CHARS).join("").trim();
  if (!limited || limited === autoTitle) return null;

  return limited;
}
