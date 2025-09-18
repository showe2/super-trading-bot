CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    tx_hash VARCHAR(88) UNIQUE NOT NULL,
    wallet_address VARCHAR(44) NOT NULL,
    token_mint VARCHAR(44) NOT NULL,
    
    -- Transaction details
    type VARCHAR(10) NOT NULL CHECK (type IN ('BUY', 'SELL')),
    
    -- Amounts
    sol_amount DECIMAL(18, 9),
    token_amount DECIMAL(25, 0),
    price_per_token DECIMAL(25, 15),
    
    -- Trade parameters
    slippage_percent DECIMAL(5, 2),
    priority_fee DECIMAL(10, 9),
    priority_type VARCHAR(10) DEFAULT 'normal',
    stop_loss_percent DECIMAL(5, 2),
    take_profit_percent DECIMAL(5, 2),
    
    -- Results
    price_impact_percent DECIMAL(5, 2),
    total_cost DECIMAL(18, 9),
    
    -- On-chain data as JSON
    on_chain_data JSONB,
    
    -- Timestamps
    confirmed_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

-- Exit
\q