import * as walletManager from './wallet-manager.js';
import { getTokenBalances, type TokenBalance } from './token-service.js';
import { getStakeAccounts, type StakeAccountInfo } from './stake-service.js';
import { getPrices, type PriceResult } from './price-service.js';
import * as snapshotRepo from '../db/repos/snapshot-repo.js';
import { verbose } from '../output/formatter.js';
import { SOL_MINT } from '../utils/solana.js';

// ── Types ─────────────────────────────────────────────────

export interface PortfolioPosition {
  type: 'token' | 'stake' | 'lend' | 'lp';
  protocol?: string;
  wallet: string;
  mint: string;
  symbol: string;
  amount: number;
  valueUsd: number | null;
  extra?: Record<string, unknown>;
}

export interface AllocationEntry {
  symbol: string;
  pct: number;
  valueUsd: number;
}

export interface PortfolioReport {
  wallets: string[];
  positions: PortfolioPosition[];
  allocation: AllocationEntry[];
  totalValueUsd: number;
  claimableMev: number;
  lastSnapshot?: { id: number; label?: string; ago: string };
}

export interface CompareResult {
  snapshotId: number | 'current';
  snapshotDate?: string;
  diffs: CompareEntry[];
  totalBefore: number;
  totalAfter: number;
  totalChange: number;
  totalChangePct: number | null;
}

export interface CompareEntry {
  wallet: string;
  symbol: string;
  valueBefore: number;
  valueAfter: number;
  change: number;
  changePct: number | null;
}

// ── Portfolio ─────────────────────────────────────────────

export async function getPortfolio(walletFilter?: string): Promise<PortfolioReport> {
  const allWallets = walletManager.listWallets();
  if (allWallets.length === 0) throw new Error('No wallets found. Create one with: sol wallet create');

  const wallets = walletFilter
    ? allWallets.filter(w => w.name === walletFilter)
    : allWallets;

  if (wallets.length === 0) throw new Error(`Wallet "${walletFilter}" not found`);

  // Fetch token balances and stake accounts in parallel per wallet
  const walletData = await Promise.all(wallets.map(async (w) => {
    const [tokens, stakes] = await Promise.all([
      getTokenBalances(w.address),
      getStakeAccounts(w.address),
    ]);
    return { wallet: w, tokens, stakes };
  }));

  // Collect all mints for batch price fetch
  const allMints = new Set<string>();
  for (const { tokens } of walletData) {
    for (const t of tokens) allMints.add(t.mint);
  }
  allMints.add(SOL_MINT); // Stake positions need SOL price

  const prices = await getPrices([...allMints]);

  // Build positions
  const positions: PortfolioPosition[] = [];
  let claimableMev = 0;

  for (const { wallet, tokens, stakes } of walletData) {
    // Token positions
    for (const t of tokens) {
      const price = prices.get(t.mint);
      positions.push({
        type: 'token',
        protocol: 'native',
        wallet: wallet.name,
        mint: t.mint,
        symbol: t.symbol,
        amount: t.uiBalance,
        valueUsd: price ? t.uiBalance * price.priceUsd : null,
      });
    }

    // Stake positions
    for (const s of stakes) {
      const solPrice = prices.get(SOL_MINT);
      positions.push({
        type: 'stake',
        protocol: 'native',
        wallet: wallet.name,
        mint: SOL_MINT,
        symbol: 'SOL',
        amount: s.solBalance,
        valueUsd: solPrice ? s.solBalance * solPrice.priceUsd : null,
        extra: {
          stakeAccount: s.address,
          validator: s.validator,
          status: s.status,
          claimableExcess: s.claimableExcess,
        },
      });
      claimableMev += s.claimableExcess;
    }
  }

  // Compute allocation (group by symbol, only valued positions)
  const symbolTotals = new Map<string, number>();
  let totalValueUsd = 0;
  for (const p of positions) {
    if (p.valueUsd != null) {
      totalValueUsd += p.valueUsd;
      symbolTotals.set(p.symbol, (symbolTotals.get(p.symbol) || 0) + p.valueUsd);
    }
  }

  const allocation: AllocationEntry[] = [...symbolTotals.entries()]
    .map(([symbol, valueUsd]) => ({
      symbol,
      pct: totalValueUsd > 0 ? (valueUsd / totalValueUsd) * 100 : 0,
      valueUsd,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  // Last snapshot hint
  const latest = snapshotRepo.getLatestSnapshot();
  let lastSnapshot: PortfolioReport['lastSnapshot'];
  if (latest) {
    lastSnapshot = {
      id: latest.id,
      label: latest.label ?? undefined,
      ago: timeAgo(latest.created_at),
    };
  }

  return {
    wallets: wallets.map(w => w.name),
    positions,
    allocation,
    totalValueUsd,
    claimableMev,
    lastSnapshot,
  };
}

// ── Snapshots ─────────────────────────────────────────────

export async function takeSnapshot(label?: string, walletFilter?: string): Promise<{
  snapshotId: number;
  walletCount: number;
  entryCount: number;
  totalValueUsd: number;
}> {
  const portfolio = await getPortfolio(walletFilter);

  const snapshotId = snapshotRepo.createSnapshot(label);
  let entryCount = 0;

  for (const p of portfolio.positions) {
    snapshotRepo.insertSnapshotEntry({
      snapshot_id: snapshotId,
      wallet_name: p.wallet,
      wallet_address: '', // Not needed for comparison, kept for compat
      mint: p.mint,
      symbol: p.symbol,
      balance: String(p.amount),
      price_usd: p.valueUsd != null && p.amount > 0 ? p.valueUsd / p.amount : null,
      value_usd: p.valueUsd,
      position_type: p.type,
      protocol: p.protocol ?? null,
      pool_id: (p.extra?.stakeAccount as string) ?? null,
    });
    entryCount++;
  }

  return {
    snapshotId,
    walletCount: portfolio.wallets.length,
    entryCount,
    totalValueUsd: portfolio.totalValueUsd,
  };
}

/** Auto-snapshot if the last one is older than 24h. Returns true if taken. */
export async function autoSnapshotIfStale(): Promise<boolean> {
  const latest = snapshotRepo.getLatestSnapshot();
  if (!latest) return false;

  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  if (ageMs < twentyFourHours) return false;

  verbose('Last snapshot is >24h old, taking auto-snapshot');
  await takeSnapshot('auto');
  return true;
}

// ── Compare ───────────────────────────────────────────────

export async function compareToSnapshot(snapshotId?: number, walletFilter?: string): Promise<CompareResult> {
  // Resolve snapshot
  let snap: ReturnType<typeof snapshotRepo.getSnapshot>;
  if (snapshotId != null) {
    snap = snapshotRepo.getSnapshot(snapshotId);
    if (!snap) throw new Error(`Snapshot #${snapshotId} not found`);
  } else {
    snap = snapshotRepo.getLatestSnapshot();
    if (!snap) throw new Error('No snapshots found. Take one with: sol portfolio snapshot');
  }

  const entries = snapshotRepo.getSnapshotEntries(snap.id);
  if (entries.length === 0) throw new Error(`Snapshot #${snap.id} is empty`);

  // Current state
  const portfolio = await getPortfolio(walletFilter);

  // Build maps keyed by wallet:mint:type
  const keyFor = (wallet: string, mint: string, type: string) => `${wallet}:${mint}:${type}`;

  const beforeMap = new Map<string, { wallet: string; symbol: string; valueUsd: number }>();
  for (const e of entries) {
    const k = keyFor(e.wallet_name, e.mint, e.position_type);
    const existing = beforeMap.get(k);
    beforeMap.set(k, {
      wallet: e.wallet_name,
      symbol: e.symbol || 'unknown',
      valueUsd: (existing?.valueUsd ?? 0) + (e.value_usd ?? 0),
    });
  }

  const afterMap = new Map<string, { wallet: string; symbol: string; valueUsd: number }>();
  for (const p of portfolio.positions) {
    const k = keyFor(p.wallet, p.mint, p.type);
    const existing = afterMap.get(k);
    afterMap.set(k, {
      wallet: p.wallet,
      symbol: p.symbol,
      valueUsd: (existing?.valueUsd ?? 0) + (p.valueUsd ?? 0),
    });
  }

  const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const diffs: CompareEntry[] = [];

  for (const key of allKeys) {
    const before = beforeMap.get(key);
    const after = afterMap.get(key);
    const v1 = before?.valueUsd ?? 0;
    const v2 = after?.valueUsd ?? 0;
    const change = v2 - v1;
    if (Math.abs(change) > 0.01) {
      diffs.push({
        wallet: before?.wallet || after?.wallet || '',
        symbol: before?.symbol || after?.symbol || 'unknown',
        valueBefore: v1,
        valueAfter: v2,
        change,
        changePct: v1 > 0 ? (change / v1) * 100 : null,
      });
    }
  }

  const totalBefore = entries.reduce((s, e) => s + (e.value_usd ?? 0), 0);
  const totalAfter = portfolio.totalValueUsd;
  const totalChange = totalAfter - totalBefore;

  return {
    snapshotId: snap.id,
    snapshotDate: snap.created_at,
    diffs: diffs.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
    totalBefore,
    totalAfter,
    totalChange,
    totalChangePct: totalBefore > 0 ? (totalChange / totalBefore) * 100 : null,
  };
}

// ── P&L ───────────────────────────────────────────────────

export async function getPnl(sinceId?: number, walletFilter?: string): Promise<CompareResult> {
  // P&L uses the oldest snapshot by default (or the specified one)
  let snapId = sinceId;
  if (snapId == null) {
    const all = snapshotRepo.listSnapshots(1000);
    if (all.length === 0) throw new Error('No snapshots found. Take one with: sol portfolio snapshot');
    snapId = all[all.length - 1].id; // oldest
  }
  return compareToSnapshot(snapId, walletFilter);
}

// ── Helpers ───────────────────────────────────────────────

function timeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
