import { beijingMidnight, isValidDate } from "./time.ts";

/** Inclusive Beijing calendar dates; a fixed interval remains stable across cursor pages. */
export function researchDates(from?: string | null, to?: string | null): { start: Date; end: Date } | null {
  if (!from && !to) return null;
  if (!from || !to || !isValidDate(from) || !isValidDate(to) || from.startsWith("0000-") || from > to) throw new RangeError("from 和 to 须同时提供有效日期 YYYY-MM-DD，且起日不晚于止日");
  const start = beijingMidnight(from);
  const end = new Date(beijingMidnight(to).getTime() + 86400000);
  if (end.getTime() - start.getTime() > 3660 * 86400000) throw new RangeError("单次检索范围最多 3660 天");
  return { start, end };
}
