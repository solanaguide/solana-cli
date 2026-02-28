import { readConfig, type Permissions, getConfigPath } from './config-manager.js';
import { getDb } from '../db/database.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

// ── Transaction limit guard ─────────────────────────────────────

export function assertWithinTransactionLimit(usdValue: number): void {
  const config = readConfig();
  const limit = config.limits?.maxTransactionUsd;
  if (limit == null) return;

  if (usdValue > limit) {
    const err = new Error(
      `Transaction blocked: $${fmtUsd(usdValue)} exceeds per-transaction limit of $${fmtUsd(limit)}.\n` +
      `Edit ~/.sol/config.toml [limits] to adjust.`
    );
    (err as any).code = 'LIMIT_EXCEEDED';
    (err as any).data = { requested_usd: usdValue, limit_usd: limit, limit_type: 'per_transaction' };
    throw err;
  }
}

// ── Daily limit guard ───────────────────────────────────────────

export function assertWithinDailyLimit(usdValue: number): void {
  const config = readConfig();
  const limit = config.limits?.maxDailyUsd;
  if (limit == null) return;

  const used = getDailyUsage();
  const projected = used + usdValue;

  if (projected > limit) {
    const remaining = Math.max(0, limit - used);
    const err = new Error(
      `Transaction blocked: $${fmtUsd(usdValue)} would bring 24h total to $${fmtUsd(projected)}, exceeding daily limit of $${fmtUsd(limit)}.\n` +
      `Used today: $${fmtUsd(used)}. Remaining: $${fmtUsd(remaining)}.\n` +
      `Edit ~/.sol/config.toml [limits] to adjust.`
    );
    (err as any).code = 'LIMIT_EXCEEDED';
    (err as any).data = { requested_usd: usdValue, used_usd: used, limit_usd: limit, limit_type: 'daily' };
    throw err;
  }
}

// ── Address allowlist guard ─────────────────────────────────────

export function assertAllowedRecipient(recipientAddress: string): void {
  const config = readConfig();
  const addresses = config.allowlist?.addresses;
  if (!addresses || addresses.length === 0) return;

  // Own wallets are always allowed
  const ownWallets = walletRepo.listWallets().map(w => w.address);
  const allowed = new Set([...addresses, ...ownWallets]);

  if (!allowed.has(recipientAddress)) {
    const err = new Error(
      `Transfer blocked: ${recipientAddress} is not in your address allowlist.\n` +
      `Edit ~/.sol/config.toml [allowlist.addresses] to add it.`
    );
    (err as any).code = 'ADDRESS_NOT_ALLOWED';
    (err as any).data = { address: recipientAddress };
    throw err;
  }
}

// ── Token allowlist guard ───────────────────────────────────────

export function assertAllowedToken(mintAddress: string, symbol: string, resolvedMints: Map<string, string>): void {
  const config = readConfig();
  const tokens = config.allowlist?.tokens;
  if (!tokens || tokens.length === 0) return;

  // Build a set of allowed mint addresses
  const allowedMints = new Set<string>();
  const allowedSymbols = new Set<string>();

  for (const entry of tokens) {
    // If it looks like a mint address (long base58), add directly
    if (entry.length > 20) {
      allowedMints.add(entry);
    } else {
      allowedSymbols.add(entry.toUpperCase());
      // If we have a resolved mint for this symbol, add it
      const mint = resolvedMints.get(entry.toUpperCase());
      if (mint) allowedMints.add(mint);
    }
  }

  if (allowedMints.has(mintAddress) || allowedSymbols.has(symbol.toUpperCase())) return;

  const err = new Error(
    `Token blocked: ${symbol} is not in your token allowlist.\n` +
    `Allowed: ${tokens.join(', ')}.\n` +
    `Edit ~/.sol/config.toml [allowlist.tokens] to adjust.`
  );
  (err as any).code = 'TOKEN_NOT_ALLOWED';
  (err as any).data = { token: symbol, mint: mintAddress };
  throw err;
}

// ── Combined limit check ────────────────────────────────────────

export function assertWithinLimits(usdValue: number): void {
  assertWithinTransactionLimit(usdValue);
  assertWithinDailyLimit(usdValue);
}

// ── Daily usage from transaction log ────────────────────────────

export function getDailyUsage(): number {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const row = getDb().prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN from_price_usd IS NOT NULL AND from_amount IS NOT NULL
        THEN CAST(from_amount AS REAL) * from_price_usd
        ELSE 0
      END
    ), 0) as total_usd
    FROM transaction_log
    WHERE status = 'confirmed'
      AND created_at >= ?
      AND type NOT IN ('withdraw', 'claim_mev', 'close')
  `).get(cutoff) as { total_usd: number };

  return row.total_usd;
}

// ── Security status for config status command ───────────────────

export interface SecurityStatus {
  permissions: Record<string, boolean>;
  canSetPermissions: boolean;
  limits: {
    maxTransactionUsd: number | null;
    maxDailyUsd: number | null;
    usedDailyUsd: number;
  };
  allowlist: {
    addresses: string[];
    addressesActive: boolean;
    tokens: string[];
    tokensActive: boolean;
  };
  ownWalletCount: number;
  configPath: string;
  warnings: string[];
}

const ALL_PERMISSIONS: (keyof Permissions)[] = [
  'canTransfer', 'canSwap', 'canStake', 'canWithdrawStake',
  'canLend', 'canWithdrawLend', 'canBorrow', 'canBurn',
  'canCreateWallet', 'canRemoveWallet', 'canExportWallet',
  'canPredict', 'canFetch',
];

export function getSecurityStatus(): SecurityStatus {
  const config = readConfig();
  const perms = config.permissions ?? {};
  const limits = config.limits ?? {};
  const allowlist = config.allowlist ?? {};

  const permMap: Record<string, boolean> = {};
  for (const p of ALL_PERMISSIONS) {
    permMap[p] = perms[p] !== false;
  }

  const canSetPermissions = perms.canSetPermissions !== false;
  const addresses = allowlist.addresses ?? [];
  const tokens = allowlist.tokens ?? [];
  const ownWalletCount = walletRepo.listWallets().length;

  let usedDailyUsd = 0;
  try {
    usedDailyUsd = getDailyUsage();
  } catch { /* DB may not exist yet */ }

  const warnings: string[] = [];

  if (canSetPermissions) {
    warnings.push('Security settings are not locked — agents can modify permissions, limits, and allowlists. Run `sol config lock` to lock.');
  }
  if (permMap.canExportWallet) {
    warnings.push('canExportWallet is enabled — agents can view key file paths.');
  }

  const rpcUrl = config.rpc?.url;
  if (!rpcUrl || rpcUrl.includes('api.mainnet-beta.solana.com')) {
    warnings.push('Using public RPC — set a dedicated RPC with: sol config set rpc.url <url>');
  }

  if (limits.maxDailyUsd && !limits.maxTransactionUsd) {
    warnings.push('Daily limit set but no per-transaction limit. Consider setting limits.maxTransactionUsd too.');
  }

  if (addresses.length === 0 && tokens.length === 0 && !limits.maxTransactionUsd && !limits.maxDailyUsd) {
    warnings.push('No limits or allowlists configured. Consider setting transaction limits for agent safety.');
  }

  return {
    permissions: permMap,
    canSetPermissions,
    limits: {
      maxTransactionUsd: limits.maxTransactionUsd ?? null,
      maxDailyUsd: limits.maxDailyUsd ?? null,
      usedDailyUsd,
    },
    allowlist: {
      addresses,
      addressesActive: addresses.length > 0,
      tokens,
      tokensActive: tokens.length > 0,
    },
    ownWalletCount,
    configPath: getConfigPath(),
    warnings,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
