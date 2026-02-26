import { verbose } from '../output/formatter.js';
import { getConfigValue } from './config-manager.js';
import { loadSigner } from './wallet-manager.js';
import type {
  LendProvider,
  LendWriteResult,
  LendingRate,
  LendingPosition,
  ProtocolName,
} from './lend/lend-provider.js';
import { PROTOCOL_NAMES } from './lend/lend-provider.js';
import { KaminoProvider } from './lend/kamino-provider.js';
import { MarginfiProvider } from './lend/marginfi-provider.js';
import { DriftProvider } from './lend/drift-provider.js';
import { JupiterLendProvider } from './lend/jupiter-lend-provider.js';
import { LoopscaleProvider } from './lend/loopscale-provider.js';

// Re-export types so existing imports keep working
export type { LendingRate, LendingPosition, LendWriteResult } from './lend/lend-provider.js';

// ── Provider registry ────────────────────────────────────

const providers: LendProvider[] = [
  new KaminoProvider(),
  new MarginfiProvider(),
  new DriftProvider(),
  new JupiterLendProvider(),
  new LoopscaleProvider(),
];

function getProvider(name: string): LendProvider {
  const p = providers.find(p => p.name === name);
  if (!p) throw new Error(`Unknown protocol: ${name}. Available: ${providers.map(p => p.name).join(', ')}`);
  return p;
}

function resolveProtocol(protocol?: string): string | undefined {
  if (!protocol) {
    const defaultProto = getConfigValue('lend.defaultProtocol') as string | undefined;
    return defaultProto || undefined;
  }
  const normalized = protocol.toLowerCase();
  if (!PROTOCOL_NAMES.includes(normalized as ProtocolName)) {
    throw new Error(`Unknown protocol: ${protocol}. Available: ${PROTOCOL_NAMES.join(', ')}`);
  }
  return normalized;
}

// ── Read operations (all protocols, Promise.allSettled) ───

export interface RatesResult {
  rates: LendingRate[];
  warnings: string[];
  bestDepositProtocol: Record<string, string>;
  bestBorrowProtocol: Record<string, string>;
}

export async function getRates(tokens?: string[], protocol?: string): Promise<RatesResult> {
  const proto = resolveProtocol(protocol);

  const targets = proto ? [getProvider(proto)] : providers;
  const results = await Promise.allSettled(targets.map(p => p.getRates(tokens)));

  const rates: LendingRate[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      rates.push(...r.value);
    } else {
      const name = targets[i].name;
      verbose(`${name} rates failed: ${r.reason}`);
      warnings.push(`${name}: ${r.reason?.message || r.reason}`);
    }
  }

  // Compute best protocol per token
  const bestDepositProtocol: Record<string, string> = {};
  const bestBorrowProtocol: Record<string, string> = {};

  const byToken = new Map<string, LendingRate[]>();
  for (const r of rates) {
    const arr = byToken.get(r.token) ?? [];
    arr.push(r);
    byToken.set(r.token, arr);
  }

  for (const [token, tokenRates] of byToken) {
    const bestDeposit = tokenRates.reduce((best, r) => r.depositApy > best.depositApy ? r : best);
    bestDepositProtocol[token] = bestDeposit.protocol;

    const borrowRates = tokenRates.filter(r => r.borrowApy > 0);
    if (borrowRates.length > 0) {
      const bestBorrow = borrowRates.reduce((best, r) => r.borrowApy < best.borrowApy ? r : best);
      bestBorrowProtocol[token] = bestBorrow.protocol;
    }
  }

  return { rates, warnings, bestDepositProtocol, bestBorrowProtocol };
}

export async function getPositions(walletAddress: string, protocol?: string): Promise<LendingPosition[]> {
  const proto = resolveProtocol(protocol);

  const targets = proto ? [getProvider(proto)] : providers;
  const results = await Promise.allSettled(targets.map(p => p.getPositions(walletAddress)));

  const positions: LendingPosition[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      positions.push(...r.value);
    } else {
      verbose(`${targets[i].name} positions failed: ${r.reason}`);
    }
  }

  return positions;
}

// ── Write operations (single protocol, fail fast) ────────

export async function deposit(
  walletName: string,
  token: string,
  amount: number,
  protocol?: string,
): Promise<LendWriteResult> {
  const proto = resolveProtocol(protocol);

  if (proto) {
    return getProvider(proto).deposit(walletName, token, amount);
  }

  // Auto-select: pick protocol with best deposit rate for this token
  const { rates, bestDepositProtocol } = await getRates([token]);
  const bestProto = bestDepositProtocol[token.toUpperCase()] ?? bestDepositProtocol[token];

  if (!bestProto && rates.length === 0) {
    throw new Error(`No lending protocol has a reserve for ${token}`);
  }

  const target = bestProto ? getProvider(bestProto) : providers[0];
  verbose(`Auto-selected ${target.name} (best deposit rate for ${token})`);
  return target.deposit(walletName, token, amount);
}

export async function withdraw(
  walletName: string,
  token: string,
  amount: number,
  protocol?: string,
): Promise<LendWriteResult> {
  const proto = resolveProtocol(protocol);

  if (proto) {
    return getProvider(proto).withdraw(walletName, token, amount);
  }

  // Auto-select: find which protocol(s) the user has a deposit in for this token
  const signer = await loadSigner(walletName);
  const allPositions = await getPositions(signer.address);
  const tokenUpper = token.toUpperCase();
  const deposits = allPositions.filter(p =>
    p.type === 'deposit' && p.token.toUpperCase() === tokenUpper
  );

  if (deposits.length === 0) {
    throw new Error(`No ${token} deposit found. Check with: sol lend positions`);
  }
  if (deposits.length === 1) {
    return getProvider(deposits[0].protocol).withdraw(walletName, token, amount);
  }

  // Ambiguous — multiple protocols have deposits
  const protos = [...new Set(deposits.map(d => d.protocol))];
  if (protos.length === 1) {
    return getProvider(protos[0]).withdraw(walletName, token, amount);
  }

  throw new Error(
    `${token} deposits found on multiple protocols: ${protos.join(', ')}. ` +
    `Specify one with --protocol, e.g.: sol lend withdraw ${amount} ${token} --protocol ${protos[0]}`
  );
}

export async function borrow(
  walletName: string,
  token: string,
  amount: number,
  collateral: string,
  protocol?: string,
): Promise<LendWriteResult> {
  const proto = resolveProtocol(protocol) ?? 'kamino'; // Default to kamino for borrow

  const provider = getProvider(proto);
  if (!provider.capabilities.borrow || !provider.borrow) {
    const available = providers.filter(p => p.capabilities.borrow).map(p => p.name);
    throw new Error(
      `${provider.name} does not support borrowing. Available: ${available.join(', ')}`
    );
  }

  return provider.borrow(walletName, token, amount, collateral);
}

export async function repay(
  walletName: string,
  token: string,
  amount: number,
  protocol?: string,
): Promise<LendWriteResult> {
  const proto = resolveProtocol(protocol);

  if (proto) {
    const provider = getProvider(proto);
    if (!provider.capabilities.repay || !provider.repay) {
      throw new Error(`${provider.name} does not support repayment.`);
    }
    return provider.repay(walletName, token, amount);
  }

  // Auto-select: find which protocol has a borrow for this token
  const signer = await loadSigner(walletName);
  const allPositions = await getPositions(signer.address);
  const tokenUpper = token.toUpperCase();
  const borrows = allPositions.filter(p =>
    p.type === 'borrow' && p.token.toUpperCase() === tokenUpper
  );

  if (borrows.length === 0) {
    throw new Error(`No ${token} borrow found. Check with: sol lend positions`);
  }

  const protos = [...new Set(borrows.map(b => b.protocol))];
  if (protos.length === 1) {
    const provider = getProvider(protos[0]);
    if (!provider.repay) throw new Error(`${provider.name} does not support repayment.`);
    return provider.repay(walletName, token, amount);
  }

  throw new Error(
    `${token} borrows found on multiple protocols: ${protos.join(', ')}. ` +
    `Specify one with --protocol, e.g.: sol lend repay ${amount} ${token} --protocol ${protos[0]}`
  );
}
