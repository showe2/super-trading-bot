
import { loadConfig } from "../helpers/superConfig";
export class AutoScalp {
  private entry: number|null=null;
  setEntry(p:number){ this.entry=p; }
  shouldTakeProfit(cur:number){ const cfg=loadConfig().trading?.autoScalp; if(!cfg?.enabled||this.entry===null) return false;
    const base = cfg.targetProfitPercent?.default??7; const gain=((cur-this.entry)/this.entry)*100; return gain>=base; }
}
