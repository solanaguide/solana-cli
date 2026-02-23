import { getDb } from '../database.js';

export interface TransactionRow {
  id: number;
  signature: string;
  type: string;
  wallet_name: string | null;
  from_mint: string | null;
  to_mint: string | null;
  from_amount: string | null;
  to_amount: string | null;
  from_price_usd: number | null;
  to_price_usd: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

export function getRecentTransactions(opts: {
  walletName?: string;
  type?: string;
  limit?: number;
} = {}): TransactionRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.walletName) {
    conditions.push('wallet_name = ?');
    params.push(opts.walletName);
  }
  if (opts.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 20;

  return getDb().prepare(
    `SELECT * FROM transaction_log ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as TransactionRow[];
}

export function getTransactionBySignature(signature: string): TransactionRow | undefined {
  return getDb().prepare(
    'SELECT * FROM transaction_log WHERE signature = ?'
  ).get(signature) as TransactionRow | undefined;
}

export function getTransactionCount(walletName?: string): number {
  if (walletName) {
    const row = getDb().prepare(
      'SELECT COUNT(*) as count FROM transaction_log WHERE wallet_name = ?'
    ).get(walletName) as { count: number };
    return row.count;
  }
  const row = getDb().prepare('SELECT COUNT(*) as count FROM transaction_log').get() as { count: number };
  return row.count;
}
