
import "dotenv/config";
import { waitAndSnipeMint } from "../trading/waitAndSnipeMint.js";
import { Notifications } from "../notifications/bus.js";
import { hasPoolNow, getLivePrice, getLiquidityUsd, qtyTokensAfterBuy } from "../integration/adapters.js";

async function main(){
  const mint = process.env.TARGET_MINT || "";
  const sol  = Number(process.env.BUY_SOL || "0.2");
  if (!mint) throw new Error("Set TARGET_MINT in .env");
  Notifications.on(e=>console.log(`[${e.level}] ${e.type} :: ${e.title}`, e.body||"", e.link||""));
  await waitAndSnipeMint(mint, sol, { hasPoolNow, getLivePrice, getLiquidityUsd, qtyTokensAfterBuy });
}
main().catch(e=>{ console.error(e); process.exit(1); });
