
import { loadConfig } from "../helpers/superConfig";
import { Notifications } from "../notifications/bus";
import { jupiter_sell } from "../jupiter/adapter";
export type SellReason="trailingStop"|"autoScalp"|"poolDrain"|"spamExit"|"manual";
export async function sellWithJupiterJito(tokenMint:string, amountTokens:number, reason:SellReason){
  const cfg=loadConfig(); const range = cfg.execution?.sell?.slippageBpsByReason?.[reason]||[150,200];
  const slippage = range[0]; const res = await jupiter_sell(tokenMint, amountTokens, slippage);
  if (cfg.execution?.sell?.unwrapWSOL){ /* TODO: unwrap */ }
  Notifications.emit({type:"sell", level:"success", title:`SELL ${tokenMint}`, body:`reason=${reason}`, link: res?.txid});
  return res;
}
