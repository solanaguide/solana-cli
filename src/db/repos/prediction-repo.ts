import { getDb } from '../database.js';

export interface PredictionPositionRow {
  id: number;
  position_pubkey: string;
  provider: string;
  wallet_name: string;
  wallet_address: string;
  market_id: string;
  market_title: string | null;
  is_yes: number;
  contracts: number;
  cost_basis_usd: number;
  deposit_mint: string | null;
  deposit_amount: string | null;
  buy_signature: string | null;
  buy_at: string | null;
  sell_signature: string | null;
  sell_at: string | null;
  claim_signature: string | null;
  claim_at: string | null;
  realized_pnl_usd: number | null;
  status: string;
}

export function insertPosition(entry: {
  position_pubkey: string;
  provider: string;
  wallet_name: string;
  wallet_address: string;
  market_id: string;
  market_title?: string;
  is_yes: boolean;
  contracts: number;
  cost_basis_usd: number;
  deposit_mint?: string;
  deposit_amount?: string;
  buy_signature?: string;
}): number {
  const result = getDb().prepare(`
    INSERT INTO prediction_positions
      (position_pubkey, provider, wallet_name, wallet_address, market_id, market_title,
       is_yes, contracts, cost_basis_usd, deposit_mint, deposit_amount, buy_signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.position_pubkey, entry.provider, entry.wallet_name, entry.wallet_address,
    entry.market_id, entry.market_title ?? null,
    entry.is_yes ? 1 : 0, entry.contracts, entry.cost_basis_usd,
    entry.deposit_mint ?? null, entry.deposit_amount ?? null, entry.buy_signature ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getPosition(positionPubkey: string): PredictionPositionRow | undefined {
  return getDb().prepare(
    'SELECT * FROM prediction_positions WHERE position_pubkey = ?'
  ).get(positionPubkey) as PredictionPositionRow | undefined;
}

export function getOpenPositions(walletName?: string): PredictionPositionRow[] {
  if (walletName) {
    return getDb().prepare(
      'SELECT * FROM prediction_positions WHERE wallet_name = ? AND status = ? ORDER BY buy_at DESC'
    ).all(walletName, 'open') as PredictionPositionRow[];
  }
  return getDb().prepare(
    'SELECT * FROM prediction_positions WHERE status = ? ORDER BY buy_at DESC'
  ).all('open') as PredictionPositionRow[];
}

export function getPositionsByMarket(marketId: string): PredictionPositionRow[] {
  return getDb().prepare(
    'SELECT * FROM prediction_positions WHERE market_id = ? ORDER BY buy_at DESC'
  ).all(marketId) as PredictionPositionRow[];
}

export function updatePositionClosed(
  positionPubkey: string,
  sellSignature: string,
  realizedPnlUsd: number,
): boolean {
  const result = getDb().prepare(`
    UPDATE prediction_positions
    SET status = 'closed', sell_signature = ?, sell_at = datetime('now'), realized_pnl_usd = ?
    WHERE position_pubkey = ?
  `).run(sellSignature, realizedPnlUsd, positionPubkey);
  return result.changes > 0;
}

export function updatePositionClaimed(
  positionPubkey: string,
  claimSignature: string,
  realizedPnlUsd: number,
): boolean {
  const result = getDb().prepare(`
    UPDATE prediction_positions
    SET status = 'claimed', claim_signature = ?, claim_at = datetime('now'), realized_pnl_usd = ?
    WHERE position_pubkey = ?
  `).run(claimSignature, realizedPnlUsd, positionPubkey);
  return result.changes > 0;
}
