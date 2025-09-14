
import { loadConfig } from "../helpers/superConfig";
export type SpamSignal = { source: "twitter"|"telegram"|"onchain"; severity: "low"|"medium"|"high"; reason: string; };
export class SpamWatcher {
  private readonly enabled: boolean; ingestedSignals: SpamSignal[] = [];
  constructor(){ this.enabled = !!loadConfig().safety?.spamWatcher; }
  push(signal: SpamSignal){ if (!this.enabled) return; this.ingestedSignals.push(signal); }
  shouldExit(){ if (!this.enabled) return { exit:false }; const h=this.ingestedSignals.find(s=>s.severity==="high");
    return h ? { exit:true, reason:`[SpamWatcher] ${h.source}: ${h.reason}` } : { exit:false }; }
  reset(){ this.ingestedSignals=[]; }
}
