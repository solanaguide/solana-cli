// ── Shared types ─────────────────────────────────────────

export interface LendingRate {
  protocol: string;
  token: string;
  mint: string;
  depositApy: number;
  borrowApy: number;
  totalDeposited: number;
  totalBorrowed: number;
  utilizationPct: number;
}

export interface LendingPosition {
  protocol: string;
  token: string;
  mint: string;
  type: 'deposit' | 'borrow';
  amount: number;
  valueUsd: number;
  apy: number;
  healthFactor?: number;
}

export interface LendWriteResult {
  signature: string;
  protocol: string;
  explorerUrl: string;
  healthFactor?: number;
  remainingDebt?: number;
}

export interface LendProviderCapabilities {
  deposit: boolean;
  withdraw: boolean;
  borrow: boolean;
  repay: boolean;
}

// ── Provider interface ───────────────────────────────────

export interface LendProvider {
  name: string;
  capabilities: LendProviderCapabilities;

  /** Fetch deposit/borrow rates, optionally filtered by token symbols. */
  getRates(tokens?: string[]): Promise<LendingRate[]>;

  /** Fetch all lending/borrowing positions for a wallet. */
  getPositions(walletAddress: string): Promise<LendingPosition[]>;

  /** Deposit tokens into the lending protocol. */
  deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult>;

  /** Withdraw tokens from the lending protocol. */
  withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult>;

  /** Borrow tokens (optional — not all protocols support it). */
  borrow?(walletName: string, token: string, amount: number, collateral: string): Promise<LendWriteResult>;

  /** Repay a loan (optional — not all protocols support it). */
  repay?(walletName: string, token: string, amount: number): Promise<LendWriteResult>;
}

/** Canonical protocol names. */
export const PROTOCOL_NAMES = ['kamino', 'marginfi', 'drift', 'jup-lend', 'loopscale'] as const;
export type ProtocolName = typeof PROTOCOL_NAMES[number];
