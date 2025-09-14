
import { loadConfig } from "../helpers/superConfig.js";
export class TrailingStop {
  private peak = 0; private stop=0;
  onPrice(p:number){ const cfg=loadConfig().trading?.trailingStop; if(!cfg?.enabled) return;
    if (p>this.peak){ this.peak=p; const range=cfg.percentRange?.earlyPump||[12,15]; this.stop=this.peak*(1-(range[0]/100)); } }
  shouldExit(p:number){ return this.stop>0 && p<=this.stop; }
}
