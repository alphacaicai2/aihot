import { researchDates } from "@aihot/contracts/research";

export function dateProblem(from: string, to: string) {
  try {
    researchDates(from, to);
    return null;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    if (!from || !to) return "请同时填写开始日期和结束日期。";
    if (from > to) return "结束日期应等于或晚于开始日期。";
    return "请输入有效日期，单次查询最多可覆盖 3660 天。";
  }
}
