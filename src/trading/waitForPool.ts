import { loadConfig } from "../helpers/superConfig.js";

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

  console.log(`🔍 Starting pool monitoring for mint: ${mint}`);
  console.log(`⏰ Max wait time: ${maxWait / 1000} seconds`);
  console.log(`🔄 Poll interval: ${poll}ms`);
  console.log(`⏳ Waiting for pool creation...`);

  let attempts = 0;

  while (true) {
    attempts++;
    const elapsed = Date.now() - start;

    console.log(
      `📡 Check #${attempts} (${Math.round(
        elapsed / 1000
      )}s elapsed) - Looking for pool...`
    );

    try {
      const info = await hasPoolNow();

      if (info) {
        console.log(`🎉 POOL FOUND!`);
        console.log(`   AMM: ${info.amm}`);
        console.log(`   Pool: ${info.pool}`);
        console.log(`   Mint: ${info.mint}`);
        return info;
      } else {
        console.log(`❌ No pool detected yet`);
      }
    } catch (error) {
      console.log(`⚠️ Error checking for pool: ${error.message}`);
    }

    if (elapsed > maxWait) {
      console.log(
        `⏰ TIMEOUT: Pool not created after ${maxWait / 1000} seconds`
      );
      throw new Error(`Timeout: pool not created for ${mint}`);
    }

    console.log(`😴 Sleeping for ${poll}ms before next check...`);
    await new Promise((r) => setTimeout(r, poll));
  }
}
