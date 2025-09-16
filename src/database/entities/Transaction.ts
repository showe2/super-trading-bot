export interface TransactionEntity {
  // Primary key
  id: number;

  // Transaction identifiers
  tx_hash: string; // Solana transaction hash
  wallet_id: number; // FK to wallets table
  token_id: number; // FK to tokens table

  // Transaction details
  type: "BUY" | "SELL";
  status: "PENDING" | "CONFIRMED" | "FAILED";

  // Amounts
  sol_amount?: number; // SOL amount (for buys)
  token_amount: string; // Token amount (big number as string)
  price_per_token?: number; // Price per token in SOL

  // Trade parameters
  slippage_percent?: number; // Slippage %
  priority_fee?: number; // Priority fee in SOL
  priority_type: "normal" | "jito"; // Execution method

  // Stop loss / Take profit
  stop_loss_percent?: number; // Stop loss %
  take_profit_percent?: number; // Take profit %

  // On-chain data
  on_chain_data?: OnChainData; // JSON data

  // Results
  price_impact_percent?: number; // Actual price impact
  gas_used?: number; // Gas fees paid
  total_cost?: number; // Total cost in SOL

  // Timestamps
  requested_at: Date; // When API request was made
  confirmed_at?: Date; // When tx was confirmed on-chain
  created_at: Date; // Record created
  updated_at: Date; // Record updated
}

// On-chain data structure
export interface OnChainData {
  currentPriceUSD?: number;
  liquidityUSD?: number;
  solReserve?: number;
  tokenReserve?: number;
  poolExists?: boolean;
  poolAddress?: string;
  dexType?: "raydium" | "pump" | "orca" | "jupiter";
  volume24h?: number;
  priceImpact?: number;
  lpLocked?: boolean;
  topHolderPercent?: number;
  tokenTax?: number;
}

// Helper interfaces
export interface WalletEntity {
  id: number;
  address: string;
  label?: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TokenEntity {
  id: number;
  mint_address: string;
  symbol?: string;
  name?: string;
  decimals: number;
  created_at: Date;
  updated_at: Date;
}

// For creating new transactions
export interface CreateTransactionRequest {
  tx_hash: string;
  wallet_address: string; // Will lookup wallet_id
  token_mint: string; // Will lookup/create token_id
  type: "BUY" | "SELL";
  sol_amount?: number;
  token_amount: string;
  price_per_token?: number;
  slippage_percent?: number;
  priority_fee?: number;
  priority_type?: "normal" | "high";
  stop_loss_percent?: number;
  take_profit_percent?: number;
  on_chain_data?: OnChainData;
}

// For database responses
export interface TransactionWithDetails extends TransactionEntity {
  wallet: {
    address: string;
    label?: string;
  };
  token: {
    mint_address: string;
    symbol?: string;
    name?: string;
    decimals: number;
  };
}

// For API responses
export interface TransactionResponse {
  success: boolean;
  data?: TransactionWithDetails;
  error?: string;
}

export interface TransactionListResponse {
  success: boolean;
  data?: {
    transactions: TransactionWithDetails[];
    total: number;
    page: number;
    limit: number;
  };
  error?: string;
}
