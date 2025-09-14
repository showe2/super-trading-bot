
type Level="info"|"success"|"warn"|"error"; export type EventType="buy"|"sell"|"trailingStop"|"whaleAlert"|"rugWarning"|"poolDrain"|"spamExit";
export interface UIEvent{ type: EventType; level: Level; title: string; body?: string; link?: string; }
type Listener=(e:UIEvent)=>void; class Bus{ private ls:Listener[]=[]; on(l:Listener){this.ls.push(l);} off(l:Listener){this.ls=this.ls.filter(x=>x!==l);} emit(e:UIEvent){this.ls.forEach(l=>l(e));}} export const Notifications=new Bus();
