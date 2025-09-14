
import { loadConfig } from "../helpers/superConfig.js";
type Sample = { ts: number; poolDeltaPercent: number };
export class AutoExitPattern {
  private buffer: Sample[] = [];
  shouldExit(): boolean {
    const cfg = loadConfig().patterns?.autoExit; if (!cfg?.enabled) return false;
    const now = Date.now(); const minWindow = (cfg.timeWindowSec?.[0]??3)*1000;
    this.buffer = this.buffer.filter(s=> now - s.ts <= (cfg.timeWindowSec?.[1]??7000));
    const totalDrain = this.buffer.reduce((acc,s)=> acc + (s.poolDeltaPercent<0? -s.poolDeltaPercent:0), 0);
    return totalDrain >= (cfg.sellTriggerPercent?.[0]??15);
  }
  pushPoolDelta(deltaPercent: number){ this.buffer.push({ ts: Date.now(), poolDeltaPercent: deltaPercent }); }
}
