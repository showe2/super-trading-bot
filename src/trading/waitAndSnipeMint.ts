import { waitForPoolByMint } from "./waitForPool.js";
import { isDevBlacklisted } from "../safety/blacklist.js";
import { maxBuyForLiquidityUSD } from "../safety/liquidity.js";
import { safeBuyWithGuards } from "./swapWithJupiterJito.js";
import { Notifications } from "../notifications/bus.js";

type Injects = {
  hasPoolNow: () => Promise<
    | {
        amm: "raydium" | "pump" | "cpmm" | "pumpswap";
        pool: string;
        mint: string;
      }
    | undefined
  >;
  getLivePrice: () => Promise<number>;
  getLiquidityUsd: () => Promise<number>;
  preDevAddress?: string;
  qtyTokensAfterBuy: () => Promise<number>;
};

export async function waitAndSnipeMint(
  mint: string,
  wishSol: number,
  inj: Injects
) {
  const pool = await waitForPoolByMint(mint, inj.hasPoolNow);
  Notifications.emit({
    type: "buy",
    level: "info",
    title: `POOL READY @ ${pool.amm}`,
    body: pool.pool,
  });
  if (inj.preDevAddress) {
    const blk = isDevBlacklisted(inj.preDevAddress);
    if (blk.blocked)
      throw new Error(
        `BLACKLIST DEV ${inj.preDevAddress}: ${blk.reason || ""}`
      );
  }
  const lpUsd = await inj.getLiquidityUsd();
  const maxAllowed = maxBuyForLiquidityUSD(lpUsd);
  const spendSol = Math.min(wishSol, maxAllowed);
  await safeBuyWithGuards({
    tokenMint: mint,
    solAmount: spendSol,
    devAddress: inj.preDevAddress,
    getLivePrice: inj.getLivePrice,
  });
  const qty = await inj.qtyTokensAfterBuy();
  // TODO: wire guardian for autosell triggers
}
