import { db } from "../connection.js";
import {
  CreateTransactionRequest,
  TransactionWithDetails,
} from "../entities/Transaction.js";

export class TransactionRepository {
  async create(transaction: CreateTransactionRequest): Promise<any> {
    const query = `
      INSERT INTO transactions (
        tx_hash, wallet_address, token_mint, type, status,
        sol_amount, token_amount, price_per_token,
        slippage_percent, priority_fee, priority_type,
        stop_loss_percent, take_profit_percent, on_chain_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;

    const values = [
      transaction.tx_hash,
      transaction.wallet_address,
      transaction.token_mint,
      transaction.type,
      "PENDING",
      transaction.sol_amount,
      transaction.token_amount,
      transaction.price_per_token,
      transaction.slippage_percent,
      transaction.priority_fee,
      transaction.priority_type || "normal",
      transaction.stop_loss_percent,
      transaction.take_profit_percent,
      JSON.stringify(transaction.on_chain_data),
    ];

    const result = await db.query(query, values);
    return result.rows[0];
  }

  // Update transaction status
  async updateStatus(
    txHash: string,
    status: "CONFIRMED" | "FAILED",
    confirmedAt?: Date
  ): Promise<void> {
    const query = `UPDATE transactions SET status = $1, confirmed_at = $2, updated_at = NOW() WHERE tx_hash = $3`;
    await db.query(query, [status, confirmedAt || new Date(), txHash]);
  }

  // Get transaction by hash
  async getByHash(txHash: string): Promise<TransactionWithDetails | null> {
    try {
      const query = `
        SELECT 
          t.*,
          w.address as wallet_address,
          w.label as wallet_label,
          tk.mint_address,
          tk.symbol as token_symbol,
          tk.name as token_name,
          tk.decimals as token_decimals
        FROM transactions t
        JOIN wallets w ON t.wallet_id = w.id
        JOIN tokens tk ON t.token_id = tk.id
        WHERE t.tx_hash = $1
      `;

      const result = await db.query(query, [txHash]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToTransactionWithDetails(result.rows[0]);
    } catch (error) {
      console.error(`❌ Failed to get transaction:`, error.message);
      throw error;
    }
  }

  // Get transactions for wallet
  async getByWallet(
    walletAddress: string,
    limit = 50,
    offset = 0
  ): Promise<TransactionWithDetails[]> {
    try {
      const query = `
        SELECT 
          t.*,
          w.address as wallet_address,
          w.label as wallet_label,
          tk.mint_address,
          tk.symbol as token_symbol,
          tk.name as token_name,
          tk.decimals as token_decimals
        FROM transactions t
        JOIN wallets w ON t.wallet_id = w.id
        JOIN tokens tk ON t.token_id = tk.id
        WHERE w.address = $1
        ORDER BY t.created_at DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await db.query(query, [walletAddress, limit, offset]);

      return result.rows.map((row) => this.mapRowToTransactionWithDetails(row));
    } catch (error) {
      console.error(`❌ Failed to get wallet transactions:`, error.message);
      throw error;
    }
  }

  // Update transaction hash (for initial PENDING records)
  async updateTransactionHash(id: number, txHash: string): Promise<void> {
    try {
      const query = `UPDATE transactions SET tx_hash = $1, updated_at = NOW() WHERE id = $2`;
      await db.query(query, [txHash, id]);
    } catch (error) {
      console.error(`❌ Failed to update transaction hash:`, error.message);
      throw error;
    }
  }

  // Update transaction results
  async updateResults(
    txHash: string,
    results: {
      price_per_token?: number;
      price_impact_percent?: number;
      gas_used?: number;
      total_cost?: number;
      token_amount?: string;
    }
  ): Promise<void> {
    try {
      const setParts = [];
      const values = [];
      let paramIndex = 1;

      if (results.price_per_token !== undefined) {
        setParts.push(`price_per_token = $${paramIndex++}`);
        values.push(results.price_per_token);
      }
      if (results.price_impact_percent !== undefined) {
        setParts.push(`price_impact_percent = $${paramIndex++}`);
        values.push(results.price_impact_percent);
      }
      if (results.gas_used !== undefined) {
        setParts.push(`gas_used = $${paramIndex++}`);
        values.push(results.gas_used);
      }
      if (results.total_cost !== undefined) {
        setParts.push(`total_cost = $${paramIndex++}`);
        values.push(results.total_cost);
      }
      if (results.token_amount !== undefined) {
        setParts.push(`token_amount = $${paramIndex++}`);
        values.push(results.token_amount);
      }

      if (setParts.length === 0) return;

      setParts.push(`updated_at = NOW()`);
      values.push(txHash);

      const query = `UPDATE transactions SET ${setParts.join(
        ", "
      )} WHERE tx_hash = $${paramIndex}`;
      await db.query(query, values);
    } catch (error) {
      console.error(`❌ Failed to update transaction results:`, error.message);
      throw error;
    }
  }

  // Helper: Get or create wallet
  private async getOrCreateWallet(address: string): Promise<number> {
    try {
      // Try to find existing wallet
      let result = await db.query("SELECT id FROM wallets WHERE address = $1", [
        address,
      ]);

      if (result.rows.length > 0) {
        return result.rows[0].id;
      }

      // Create new wallet
      result = await db.query(
        "INSERT INTO wallets (address) VALUES ($1) RETURNING id",
        [address]
      );

      console.log(`✅ Created new wallet: ${address}`);
      return result.rows[0].id;
    } catch (error) {
      console.error(`❌ Failed to get/create wallet:`, error.message);
      throw error;
    }
  }

  // Helper: Get or create token
  private async getOrCreateToken(mintAddress: string): Promise<number> {
    try {
      // Try to find existing token
      let result = await db.query(
        "SELECT id FROM tokens WHERE mint_address = $1",
        [mintAddress]
      );

      if (result.rows.length > 0) {
        return result.rows[0].id;
      }

      // Create new token
      result = await db.query(
        "INSERT INTO tokens (mint_address) VALUES ($1) RETURNING id",
        [mintAddress]
      );

      console.log(`✅ Created new token: ${mintAddress}`);
      return result.rows[0].id;
    } catch (error) {
      console.error(`❌ Failed to get/create token:`, error.message);
      throw error;
    }
  }

  // Helper: Map database row to entity
  private mapRowToTransactionWithDetails(row: any): TransactionWithDetails {
    return {
      id: row.id,
      tx_hash: row.tx_hash,
      wallet_id: row.wallet_id,
      token_id: row.token_id,
      type: row.type,
      status: row.status,
      sol_amount: parseFloat(row.sol_amount),
      token_amount: row.token_amount,
      price_per_token: parseFloat(row.price_per_token),
      slippage_percent: parseFloat(row.slippage_percent),
      priority_fee: parseFloat(row.priority_fee),
      priority_type: row.priority_type,
      stop_loss_percent: parseFloat(row.stop_loss_percent),
      take_profit_percent: parseFloat(row.take_profit_percent),
      on_chain_data: row.on_chain_data,
      price_impact_percent: parseFloat(row.price_impact_percent),
      gas_used: parseFloat(row.gas_used),
      total_cost: parseFloat(row.total_cost),
      requested_at: row.requested_at,
      confirmed_at: row.confirmed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      wallet: {
        address: row.wallet_address,
        label: row.wallet_label,
      },
      token: {
        mint_address: row.mint_address,
        symbol: row.token_symbol,
        name: row.token_name,
        decimals: row.token_decimals,
      },
    };
  }
}

export const transactionRepo = new TransactionRepository();
