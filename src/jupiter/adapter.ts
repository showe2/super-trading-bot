export async function jupiter_buy(
  tokenMint: string,
  solAmount: number,
  slippageBps?: number
): Promise<{ txid: string; price?: number }> {
  return { txid: "TXID_BUY_STUB" };
}
export async function jupiter_sell(
  tokenMint: string,
  amountTokens: number,
  slippageBps?: number
): Promise<{ txid: string }> {
  return { txid: "TXID_SELL_STUB" };
}
