
import { loadConfig } from "../helpers/superConfig.js";
export type LiquidityBand = "low"|"medium"|"high";
export function pickLiquidityBandUSD(lpUsd: number): LiquidityBand {
  const b = loadConfig().safety?.liquidityLimits?.bandsUsd;
  if (!b) return "medium";
  if (lpUsd < (b.low?.lpMaxUsd??1000)) return "low";
  if (lpUsd < (b.high?.lpMinUsd??10000)) return "medium";
  return "high";
}
export function maxBuyForLiquidityUSD(lpUsd: number): number {
  const cfg = loadConfig().safety?.liquidityLimits?.bandsUsd;
  const band = pickLiquidityBandUSD(lpUsd);
  return cfg?.[band]?.maxBuySol ?? 0.3;
}
