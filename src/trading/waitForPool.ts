import { loadConfig } from "../helpers/superConfig";
export type PoolInfo = {
  amm: "raydium" | "pump" | "cpmm" | "pumpswap";
  pool: string;
  mint: string;
};
export async function waitForPoolByMint(
  mint: string,
  hasPoolNow: () => Promise<PoolInfo | undefined>
): Promise<PoolInfo> {
  const exec = loadConfig().execution;
  const maxWait = (exec?.mintWait?.maxWaitSecPresets?.standard ?? 3600) * 1000;
  const poll = exec?.mintWait?.pollMs ?? 600;
  const start = Date.now();
  while (true) {
    const info = await hasPoolNow();
    if (info) return info;
    if (Date.now() - start > maxWait)
      throw new Error(`Timeout: pool not created for ${mint}`);
    await new Promise((r) => setTimeout(r, poll));
  }
}
