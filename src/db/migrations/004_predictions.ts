export const migration004 = `
CREATE TABLE IF NOT EXISTS prediction_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_pubkey TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'jupiter',
  wallet_name TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_title TEXT,
  is_yes INTEGER NOT NULL,
  contracts REAL NOT NULL,
  cost_basis_usd REAL NOT NULL,
  deposit_mint TEXT,
  deposit_amount TEXT,
  buy_signature TEXT,
  buy_at TEXT DEFAULT (datetime('now')),
  sell_signature TEXT,
  sell_at TEXT,
  claim_signature TEXT,
  claim_at TEXT,
  realized_pnl_usd REAL,
  status TEXT DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_prediction_positions_wallet
  ON prediction_positions(wallet_name);
CREATE INDEX IF NOT EXISTS idx_prediction_positions_market
  ON prediction_positions(market_id);
CREATE INDEX IF NOT EXISTS idx_prediction_positions_status
  ON prediction_positions(status);
`;
