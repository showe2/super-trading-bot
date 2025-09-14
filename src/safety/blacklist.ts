import { loadConfig } from "../helpers/superConfig";
import fs from "fs";
import path from "path";
export function isDevBlacklisted(devAddress: string): {
  blocked: boolean;
  reason?: string;
} {
  const cfg = loadConfig();
  if (!cfg.blacklist?.enabled) return { blocked: false };
  const file = cfg.blacklist?.file || "blacklist.json";
  const p = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const bl = fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, "utf-8"))
    : { devWallets: [] };
  const f = bl.devWallets.find((x: any) => x.address === devAddress);
  return f ? { blocked: true, reason: f.reason } : { blocked: false };
}
