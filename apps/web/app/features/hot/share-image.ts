import type { HotResponse } from "@aihot/contracts/site";
import { SITE, withSubject } from "@aihot/industry/site";

/** Wrap by grapheme so Chinese, long URLs and emoji all fit without losing text. */
export function wrapText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const { segment } of new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text.replace(/\s+/g, " ").trim())) {
    if (line && measure(line + segment) > width) {
      lines.push(line);
      line = "";
    }
    line += segment;
  }
  if (line) lines.push(line);
  return lines;
}

export async function createHotShareImage(hot: HotResponse, url: string): Promise<Blob> {
  if (!hot.entries.length) throw new Error("empty ranking");
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  const setFont = (size: number, weight = 400) => { ctx.font = `${weight} ${size}px ${font}`; };
  const wrap = (text: string, width: number) => wrapText(text, width, (line) => ctx.measureText(line).width);
  setFont(25, 600);
  const rows = hot.entries.map((entry) => ({ entry, lines: wrap(entry.story.title, 480) }));
  setFont(16);
  const address = wrap(url, 624);
  const height = 244 + rows.reduce((sum, row) => sum + row.lines.length * 36 + 64, 0) + 110 + address.length * 24;
  // Keep mobile canvas memory bounded even if an unusually long title is returned.
  const scale = Math.min(2, 8192 / height);
  canvas.width = Math.round(720 * scale);
  canvas.height = Math.round(height * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#faf9f6";
  ctx.fillRect(0, 0, 720, height);
  ctx.fillStyle = "#176b75";
  ctx.fillRect(0, 0, 720, 8);
  const text = (value: string, x: number, y: number, size: number, color: string, weight = 400) => {
    setFont(size, weight);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  text(SITE.name, 48, 58, 21, "#176b75", 600);
  text(withSubject("热点榜"), 48, 116, 40, "#202a30", 700);
  text(`过去 ${hot.windowHours} 小时 · ${rows.length} 个热点事件`, 48, 155, 19, "#59656b");
  const date = hot.computedAt ? new Date(hot.computedAt) : null;
  const updated = date && Number.isFinite(date.getTime())
    ? `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} 更新（北京时间）`
    : "更新时间暂不可用";
  text(updated, 48, 190, 16, "#59656b");
  let y = 244;
  for (const { entry, lines } of rows) {
    text(String(entry.rank).padStart(2, "0"), 48, y, 25, entry.rank <= 3 ? "#b64a35" : "#79868c", 700);
    lines.forEach((line, i) => text(line, 104, y + i * 36, 25, "#202a30", 600));
    ctx.textAlign = "right";
    text(String(Math.round(entry.heat)), 672, y, 24, "#176b75", 700);
    text("热度", 672, y + 26, 13, "#79868c");
    ctx.textAlign = "left";
    y += lines.length * 36;
    text(`${entry.sourceCount} 个来源 · ${entry.participantCount} 位参与者`, 104, y, 16, "#59656b");
    ctx.fillStyle = "#e3e5e1";
    ctx.fillRect(48, y + 26, 624, 1);
    y += 64;
  }
  text("热度反映监测范围内的讨论活跃程度", 48, y + 8, 16, "#59656b");
  address.forEach((line, i) => text(line, 48, y + 43 + i * 24, 16, "#176b75"));
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png"));
}
