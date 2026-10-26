import type { Tab } from "./tab-title";

/** 弹窗里的一行：用户起的名字 + shell 给的原标题（副行）。 */
export interface RenamedTab {
  id: number;
  /** customTitle —— 用户手动改的名字。 */
  title: string;
  /** autoTitle —— shell 通过 OSC 0/2 给的标题，用作副行。 */
  shellTitle: string;
}

/** 待执行的退出动作。窗口关闭与 macOS Cmd+Q 共用同一套弹窗。 */
export type PendingClose = "close-window" | "quit-app";

/**
 * 需要退出确认的标签页：用户改过名的那些，保持标签栏顺序。
 *
 * 只认 `customTitle`；OSC 自动标题不算——否则每次关窗都要弹。
 */
export function renamedTabs(tabs: readonly Tab[]): RenamedTab[] {
  return tabs
    .filter((tab): tab is Tab & { customTitle: string } => tab.customTitle != null)
    .map((tab) => ({
      id: tab.id,
      title: tab.customTitle,
      shellTitle: tab.autoTitle,
    }));
}

export function needsQuitConfirm(tabs: readonly Tab[]): boolean {
  return tabs.some((tab) => tab.customTitle != null);
}

/**
 * 收到新的退出请求时要不要开弹窗：已经有一个待执行动作就忽略，
 * 避免连按 Cmd+Q / 连点 X 叠出多个弹窗。
 */
export function nextPendingClose(
  current: PendingClose | null,
  incoming: PendingClose,
): PendingClose | null {
  return current ?? incoming;
}
