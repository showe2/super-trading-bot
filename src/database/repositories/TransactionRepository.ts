import { db } from "../connection.js";

export class TransactionRepository {
  // Only save successful transactions
  async createSuccessful(
    txHash: string,
    walletAddress: string,
    tokenMint: string,
    type: "BUY" | "SELL",
    data: {
      sol_amount?: number;
      token_amount?: string;
      price_per_token?: number;
      slippage_percent?: number;
      priority_fee?: number;
      priority_type?: string;
      stop_loss_percent?: number;
      take_profit_percent?: number;
      price_impact_percent?: number;
      total_cost?: number;
      on_chain_data?: any;
    }
  ): Promise<any> {
    try {
      const query = `
      INSERT INTO transactions (
        tx_hash, wallet_address, token_mint, type,
        sol_amount, token_amount, price_per_token,
        slippage_percent, priority_fee, priority_type,
        stop_loss_percent, take_profit_percent,
        price_impact_percent, total_cost, on_chain_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

      const values = [
        txHash,
        walletAddress,
        tokenMint,
        type,
        data.sol_amount,
        data.token_amount,
        data.price_per_token,
        data.slippage_percent,
        data.priority_fee,
        data.priority_type || "normal",
        data.stop_loss_percent,
        data.take_profit_percent,
        data.price_impact_percent,
        data.total_cost,
        JSON.stringify(data.on_chain_data),
      ];

      const result = await db.query(query, values);
      console.log(`✅ Successful transaction saved: ${txHash}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Failed to save transaction:`, error.message);
      throw error;
    }
  }

  // Get transactions by wallet
  async getByWallet(
    walletAddress: string,
    limit = 50,
    offset = 0
  ): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM transactions 
        WHERE wallet_address = $1 
        ORDER BY created_at DESC 
        LIMIT $2 OFFSET $3
      `;

      const result = await db.query(query, [walletAddress, limit, offset]);
      return result.rows;
    } catch (error) {
      console.error(`❌ Failed to get transactions:`, error.message);
      throw error;
    }
  }

  // Get recent transactions
  async getRecent(limit: number = 20): Promise<any[]> {
    try {
      const query = `
        SELECT * FROM transactions 
        ORDER BY created_at DESC 
        LIMIT $1
      `;

      const result = await db.query(query, [limit]);
      return result.rows;
    } catch (error) {
      console.error(`❌ Failed to get recent transactions:`, error.message);
      throw error;
    }
  }
}

export const transactionRepo = new TransactionRepository();
