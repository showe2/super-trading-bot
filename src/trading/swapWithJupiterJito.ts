
import { isDevBlacklisted } from "../safety/blacklist.js";
import { TrailingStop } from "./trailingStop.js";
import { AutoScalp } from "./autoScalp.js";
import { AutoExitPattern } from "../patterns/autoExit.js";
import { SpamWatcher } from "../safety/spamWatcher.js";
import { Notifications } from "../notifications/bus.js";
import { loadConfig } from "../helpers/superConfig.js";
import { jupiter_buy } from "../jupiter/adapter.js";

type BuyParams = {
  tokenMint: string; solAmount: number; devAddress?: string;
  getLivePrice: () => Promise<number>; onTick?: (p:number)=>void;
};

export async function safeBuyWithGuards(p: BuyParams){
  const cfg=loadConfig();
  if (p.devAddress){ const blk=isDevBlacklisted(p.devAddress); if(blk.blocked) throw new Error(`BLACKLISTED DEV: ${blk.reason||""}`); }
  const result = await jupiter_buy(p.tokenMint, p.solAmount);
  Notifications.emit({type:"buy", level:"success", title:`BUY ${p.tokenMint}`, link: result?.txid});
  const entry = await p.getLivePrice();
  const ts=new TrailingStop(); const sc=new AutoScalp(); sc.setEntry(entry);
  const axe=new AutoExitPattern(); const sw=new SpamWatcher();
  let keep=true;
  while(keep){ const price=await p.getLivePrice(); ts.onPrice(price); p.onTick?.(price);
    if (ts.shouldExit(price)){ Notifications.emit({type:"trailingStop", level:"warn", title:"Trailing stop exit"}); keep=false; break; }
    if (sc.shouldTakeProfit(price)){ Notifications.emit({type:"sell", level:"success", title:"AutoScalp take profit"}); keep=false; break; }
    if (axe.shouldExit()){ Notifications.emit({type:"sell", level:"error", title:"AutoExit: pool drain pattern"}); keep=false; break; }
    const sp = sw.shouldExit(); if (sp.exit){ Notifications.emit({type:"sell", level:"error", title:"SpamWatcher exit", body: sp.reason}); keep=false; break; }
    await new Promise(r=>setTimeout(r,400));
  }
  return result;
}
