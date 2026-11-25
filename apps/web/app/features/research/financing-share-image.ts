import type { FinancingClaim, FinancingResponse } from "@aihot/contracts/financing";
import { beijingDate } from "@aihot/contracts/time";
import { SITE } from "@aihot/industry/site";
import { wrapText } from "../hot/share-image.ts";

export const statusLabel = { planned: "计划中", ongoing: "进行中", announced: "已宣布", closed: "已完成", unknown: "状态未明确" };
export const basisLabel = { round: "本轮金额", cumulative: "累计金额", target: "目标金额", unknown: "金额口径未明确" };
export function amount(claim: FinancingClaim) {
  return claim.amountText ? [claim.amountText, claim.currency].filter(Boolean).join(" ") : "";
}

export function financingPosterFields(claim: FinancingClaim) {
  return [
    { label: "轮次", value: claim.round || "未披露" },
    { label: claim.amountText ? basisLabel[claim.amountBasis] : "融资金额", value: amount(claim) || "未披露" },
    { label: "投资机构", value: claim.investors.join("、") || "未披露" },
  ];
}

// Render from the same member-visible claim as the card, keeping each source's terms together.
export async function createFinancingShareImage(event: FinancingResponse["events"][number]): Promise<Blob> {
  const source = event.reports[0];
  if (!source) throw new Error("missing financing report");
  const claim = source.claim;
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const width = 640, margin = 44, content = width - 2 * margin;
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  const rows: {line:string; y:number; size:number; weight:number; color:string}[] = [];
  const rules: number[] = [];
  let y = 42;
  function paragraph(value:string, size:number, weight:number, color:string, leading:number) {
    ctx!.font = `${weight} ${size}px ${font}`;
    const lines = wrapText(value, content, s => ctx!.measureText(s).width);
    for (const line of lines) {
      rows.push({line, y, size, weight, color});
      y += leading;
    }
  }
  const ink = "#17282d", accent = "#176b75", muted = "#53676c";
  paragraph(SITE.name + "  /  融资数据库", 20, 600, accent, 32);
  y += 32;
  paragraph(claim.kind === "fund_raise" ? "基金" : "公司", 18, 500, muted, 31);
  paragraph(claim.company, 48, 700, ink, 63);
  const disclosure = claim.recordType === "aggregate_disclosure" ? "合计披露" : claim.recordType === "unresolved" ? "交易归属待核实" : "";
  paragraph([statusLabel[claim.status], disclosure].filter(Boolean).join(" · "), 20, 500, muted, 32);
  for (const {label,value} of financingPosterFields(claim)) {
    y += 17;
    rules.push(y);
    y += 22;
    paragraph(label, 19, 500, muted, 32);
    paragraph(value, label === "投资机构" ? 27 : 32, 600, ink, label === "投资机构" ? 43 : 45);
  }
  y += 20;
  const footer = y;
  y += 24;
  paragraph(`据${source.sourceName}${source.publishedAt ? " · "+beijingDate(source.publishedAt) : ""}`, 18, 500, muted, 26);
  if (event.differingClaims) paragraph("同一事件的其他报道口径有差异", 17, 400, muted, 25);
  const height = y + 22;
  const scale = Math.min(2, 8192 / height);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#faf9f6";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, width, 8);
  ctx.fillStyle = "#d8e0df";
  for (const top of rules) ctx.fillRect(margin, top, content, 1);
  ctx.fillStyle = "#edf2f0";
  ctx.fillRect(0, footer, width, height - footer);
  ctx.textBaseline = "top";
  for (const row of rows) {
    ctx.font = `${row.weight} ${row.size}px ${font}`;
    ctx.fillStyle = row.color;
    ctx.fillText(row.line, margin, row.y);
  }
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png"));
}
