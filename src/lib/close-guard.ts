import type { Tab } from "./tab-title";
import { displayTitle } from "./tab-title";

/** 后端上报的一个进程。 */
export interface ActivityProcess {
  pid: number;
  name: string;
}

/** 一个会话的当前活动：前台作业和/或长期存活的后台进程。 */
export interface SessionActivity {
  id: number;
  foreground?: ActivityProcess | null;
  background?: ActivityProcess[];
}

/** 弹窗里的一行：标签标题、shell 原标题，以及触发提醒的原因。 */
export interface ConfirmRow {
  id: number;
  title: string;
  shellTitle: string;
  /** 用户改过名。 */
  custom: boolean;
  foreground: ActivityProcess | null;
  background: ActivityProcess[];
}

/** 弹窗确认后要执行的动作。 */
export type ConfirmAction = "quit" | "close-tab";

export function isTabBusy(activity?: SessionActivity | null): boolean {
  if (!activity) return false;
  return Boolean(activity.foreground) || (activity.background?.length ?? 0) > 0;
}

/**
 * 组装确认弹窗的行：
 * - 不传 `onlyId`：窗口退出，列出「改过名 或 仍有进程」的全部标签；
 * - 传 `onlyId`：关闭单个标签，只有该标签仍忙时才返回它（改名不算理由）。
 * 保持标签栏顺序。
 */
export function buildConfirmRows(
  tabs: readonly Tab[],
  activity: readonly SessionActivity[] = [],
  options: { onlyId?: number } = {},
): ConfirmRow[] {
  const byId = new Map(activity.map((item) => [item.id, item]));
  const rows: ConfirmRow[] = [];

  for (const tab of tabs) {
    if (options.onlyId != null && tab.id !== options.onlyId) continue;

    const act = byId.get(tab.id) ?? null;
    const custom = tab.customTitle != null;
    if (options.onlyId != null) {
      if (!isTabBusy(act)) continue;
    } else if (!custom && !isTabBusy(act)) {
      continue;
    }

    rows.push({
      id: tab.id,
      title: displayTitle(tab),
      shellTitle: tab.autoTitle,
      custom,
      foreground: act?.foreground ?? null,
      background: act?.background ?? [],
    });
  }

  return rows;
}

/**
 * 收到新的关闭/退出请求时是否开新弹窗：已经有一个待处理动作就忽略，
 * 避免连按 Cmd+Q / 连点 X / 双击关闭叠出多个弹窗。
 */
export function nextConfirmAction<T>(current: T | null, incoming: T): T | null {
  return current ?? incoming;
}
