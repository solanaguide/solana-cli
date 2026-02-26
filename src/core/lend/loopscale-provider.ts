import {
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { loadSigner } from '../wallet-manager.js';
import { resolveToken, type TokenMetadata } from '../token-registry.js';
import { sendEncodedTransaction } from '../transaction.js';
import { getRpc } from '../rpc.js';
import { getPrices } from '../price-service.js';
import { getTokenBalances } from '../token-service.js';
import { verbose } from '../../output/formatter.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';

// ── Constants ────────────────────────────────────────────

const LOOPSCALE_BASE_URL = 'https://tars.loopscale.com/v1';
const VAULT_CACHE_TTL_MS = 60_000;
const SECONDS_PER_YEAR = 31_536_000;

// ── HTTP helper ──────────────────────────────────────────

async function loopscaleFetch(
  path: string,
  body?: Record<string, any>,
  walletAddress?: string,
): Promise<any> {
  const url = `${LOOPSCALE_BASE_URL}${path}`;
  verbose(`Loopscale API: POST ${url}`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (walletAddress) headers['user-wallet'] = walletAddress;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Loopscale API error ${resp.status}: ${text}`);
  }

  return resp.json();
}

// ── Helpers ──────────────────────────────────────────────

async function resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
  const meta = await resolveToken(symbolOrMint);
  if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
  return meta;
}

// ── Vault cache ──────────────────────────────────────────

interface VaultInfo {
  address: string;
  principalMint: string;
  symbol: string;
  decimals: number;
  depositApy: number;
  borrowApy: number;
  totalDeposited: number;
  totalBorrowed: number;
  utilizationPct: number;
}

let vaultCache: VaultInfo[] = [];
let vaultCacheTs = 0;

async function fetchVaults(): Promise<VaultInfo[]> {
  if (Date.now() - vaultCacheTs < VAULT_CACHE_TTL_MS && vaultCache.length > 0) {
    return vaultCache;
  }

  const data = await loopscaleFetch('/markets/lending_vaults/info', {});
  const vaults: VaultInfo[] = [];

  for (const v of data) {
    const principalMint = v.principalMint ?? v.principal_mint;
    if (!principalMint) continue;

    const symbol = v.principalSymbol ?? v.principal_symbol ?? v.symbol ?? '';
    const decimals = v.principalDecimals ?? v.principal_decimals ?? v.decimals ?? 6;
    const mintFactor = Math.pow(10, decimals);

    // Deposit APY from vault yield
    const depositApy = parseFloat(v.apy ?? v.depositApy ?? v.deposit_apy ?? '0');

    // Borrow APY derived from strategy data
    let borrowApy = 0;
    const strategies = v.strategies ?? v.loanStrategies ?? [];
    for (const s of strategies) {
      const interestPerSec = parseFloat(s.interestPerSecond ?? s.interest_per_second ?? '0');
      const deployed = parseFloat(s.currentDeployedAmount ?? s.current_deployed_amount ?? '0');
      if (deployed > 0 && interestPerSec > 0) {
        borrowApy = (interestPerSec * SECONDS_PER_YEAR) / deployed;
        break; // Use first strategy with data
      }
    }

    const totalDeposited = parseFloat(v.totalAssets ?? v.total_assets ?? '0') / mintFactor;
    const totalBorrowed = parseFloat(v.totalBorrowed ?? v.total_borrowed ?? '0') / mintFactor;
    const utilizationPct = totalDeposited > 0 ? (totalBorrowed / totalDeposited) * 100 : 0;

    vaults.push({
      address: v.address ?? v.vaultAddress ?? v.vault_address ?? '',
      principalMint,
      symbol,
      decimals,
      depositApy,
      borrowApy,
      totalDeposited,
      totalBorrowed,
      utilizationPct,
    });
  }

  vaultCache = vaults;
  vaultCacheTs = Date.now();
  return vaults;
}

function findBestVault(vaults: VaultInfo[], mint: string): VaultInfo | undefined {
  const matching = vaults.filter(v => v.principalMint === mint);
  if (matching.length === 0) return undefined;
  return matching.reduce((best, v) => v.depositApy > best.depositApy ? v : best);
}

// ── Transaction signing ──────────────────────────────────

async function signAndSendLoopscaleTx(
  base64Tx: string,
  signer: any,
  txOpts?: Parameters<typeof sendEncodedTransaction>[1],
): Promise<string> {
  const rpc = getRpc();

  const txBytes = Buffer.from(base64Tx, 'base64');
  const tx = getTransactionDecoder().decode(txBytes);

  const compiledMsg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

  const signedMsg = Object.assign({}, msg, { feePayer: signer });
  const signedTx = await signTransactionMessageWithSigners(signedMsg);
  const encoded = getBase64EncodedWireTransaction(signedTx);

  const result = await sendEncodedTransaction(encoded, txOpts);
  return result.signature;
}

/**
 * Some Loopscale operations (borrow, repay) return multiple transactions
 * that must be sent sequentially. Returns the last signature.
 */
async function signAndSendLoopscaleTxs(
  transactions: string[],
  signer: any,
  txOpts?: Parameters<typeof sendEncodedTransaction>[1],
): Promise<string> {
  let lastSig = '';
  for (let i = 0; i < transactions.length; i++) {
    // Only log the first tx to transaction_log to avoid double-counting
    const opts = i === 0 ? txOpts : { ...txOpts, txType: undefined };
    lastSig = await signAndSendLoopscaleTx(transactions[i], signer, opts);
    verbose(`Loopscale tx ${i + 1}/${transactions.length}: ${lastSig}`);
  }
  return lastSig;
}

// ── Provider ─────────────────────────────────────────────

export class LoopscaleProvider implements LendProvider {
  name = 'loopscale' as const;
  capabilities = { deposit: true, withdraw: true, borrow: true, repay: true };

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const vaults = await fetchVaults();

    const rates: LendingRate[] = [];
    for (const v of vaults) {
      if (tokens && tokens.length > 0) {
        const match = tokens.some(t =>
          t.toUpperCase() === v.symbol.toUpperCase() ||
          t === v.principalMint
        );
        if (!match) continue;
      }

      rates.push({
        protocol: 'loopscale',
        token: v.symbol || 'unknown',
        mint: v.principalMint,
        depositApy: v.depositApy,
        borrowApy: v.borrowApy,
        totalDeposited: v.totalDeposited,
        totalBorrowed: v.totalBorrowed,
        utilizationPct: v.utilizationPct,
      });
    }

    // Deduplicate: keep highest deposit APY per mint
    const byMint = new Map<string, LendingRate>();
    for (const r of rates) {
      const existing = byMint.get(r.mint);
      if (!existing || r.depositApy > existing.depositApy) {
        byMint.set(r.mint, r);
      }
    }

    return [...byMint.values()];
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    verbose(`Fetching Loopscale positions for ${walletAddress}`);
    const positions: LendingPosition[] = [];

    // Fetch deposits and borrows in parallel
    const [deposits, borrows, vaults] = await Promise.all([
      loopscaleFetch('/markets/lending_vaults/deposits', { owners: [walletAddress] })
        .catch(() => []),
      loopscaleFetch('/markets/loans/info', {
        borrowers: [walletAddress],
        filterType: 0, // Active loans
      }).catch(() => []),
      fetchVaults(),
    ]);

    // Collect mints for price lookup
    const mints = new Set<string>();

    // Process deposits
    for (const d of deposits) {
      const vault = vaults.find(v => v.address === (d.vaultAddress ?? d.vault_address ?? d.vault));
      if (!vault) continue;
      mints.add(vault.principalMint);
    }

    // Process borrows
    for (const loan of borrows) {
      const principalMint = loan.principalMint ?? loan.principal_mint;
      if (principalMint) mints.add(principalMint);
    }

    const prices = mints.size > 0 ? await getPrices([...mints]) : new Map();

    // Map deposits to positions
    for (const d of deposits) {
      const vault = vaults.find(v => v.address === (d.vaultAddress ?? d.vault_address ?? d.vault));
      if (!vault) continue;

      const decimals = vault.decimals;
      const mintFactor = Math.pow(10, decimals);
      const rawAmount = parseFloat(d.underlyingAmount ?? d.underlying_amount ?? d.amount ?? '0');
      const amount = rawAmount / mintFactor;
      if (amount <= 0) continue;

      const price = prices.get(vault.principalMint)?.priceUsd ?? 0;

      positions.push({
        protocol: 'loopscale',
        token: vault.symbol || 'unknown',
        mint: vault.principalMint,
        type: 'deposit',
        amount,
        valueUsd: amount * price,
        apy: vault.depositApy,
      });
    }

    // Map borrows to positions
    for (const loan of borrows) {
      const principalMint = loan.principalMint ?? loan.principal_mint;
      if (!principalMint) continue;

      const decimals = loan.principalDecimals ?? loan.principal_decimals ?? 6;
      const mintFactor = Math.pow(10, decimals);
      const symbol = loan.principalSymbol ?? loan.principal_symbol ?? 'unknown';

      // Outstanding principal
      const rawAmount = parseFloat(
        loan.principalAmount ?? loan.principal_amount ??
        loan.ledger?.principalAmount ?? loan.ledger?.principal_amount ?? '0'
      );
      const amount = rawAmount / mintFactor;
      if (amount <= 0) continue;

      // APY from loan ledger
      const apy = parseFloat(loan.ledger?.apy ?? loan.apy ?? '0');
      const price = prices.get(principalMint)?.priceUsd ?? 0;

      positions.push({
        protocol: 'loopscale',
        token: symbol,
        mint: principalMint,
        type: 'borrow',
        amount,
        valueUsd: amount * price,
        apy,
      });
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    // Find best vault for this token
    const vaults = await fetchVaults();
    const vault = findBestVault(vaults, meta.mint);
    if (!vault) throw new Error(`No Loopscale vault found for ${meta.symbol}`);

    verbose(`Using Loopscale vault ${vault.address} (APY: ${(vault.depositApy * 100).toFixed(2)}%)`);

    const resp = await loopscaleFetch('/markets/lending_vaults/deposit', {
      vaultAddress: vault.address,
      amount: rawAmount,
      minLpAmount: '0',
    }, signer.address);

    const txData = resp.transaction ?? resp.tx;
    if (!txData) throw new Error('Loopscale API did not return a transaction');

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const signature = await signAndSendLoopscaleTx(txData, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    const { explorerUrl } = await import('../../utils/solana.js');

    return {
      signature,
      protocol: 'loopscale',
      explorerUrl: explorerUrl(signature),
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);

    // Find vault
    const vaults = await fetchVaults();
    const vault = findBestVault(vaults, meta.mint);
    if (!vault) throw new Error(`No Loopscale vault found for ${meta.symbol}`);

    const isMax = !isFinite(amount);
    const body: Record<string, any> = {
      vaultAddress: vault.address,
    };

    if (isMax) {
      body.withdrawAll = true;
      body.maxAmountLp = String(Number.MAX_SAFE_INTEGER);
    } else {
      body.amount = uiToTokenAmount(amount, meta.decimals).toString();
    }

    const resp = await loopscaleFetch('/markets/lending_vaults/withdraw', body, signer.address);

    const txData = resp.transaction ?? resp.tx;
    if (!txData) throw new Error('Loopscale API did not return a transaction');

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const rawAmount = isMax ? '0' : uiToTokenAmount(amount, meta.decimals).toString();

    const signature = await signAndSendLoopscaleTx(txData, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    const { explorerUrl } = await import('../../utils/solana.js');

    return {
      signature,
      protocol: 'loopscale',
      explorerUrl: explorerUrl(signature),
    };
  }

  async borrow(walletName: string, token: string, amount: number, collateral: string): Promise<LendWriteResult> {
    const [borrowMeta, collateralMeta] = await Promise.all([
      resolveTokenStrict(token),
      resolveTokenStrict(collateral),
    ]);
    const signer = await loadSigner(walletName);
    const rawAmount = uiToTokenAmount(amount, borrowMeta.decimals).toString();

    // Get collateral balance for quote
    const balances = await getTokenBalances(signer.address);
    const collateralBalance = balances.find(b => b.mint === collateralMeta.mint);
    if (!collateralBalance || parseFloat(collateralBalance.balance) <= 0) {
      throw new Error(`No ${collateralMeta.symbol} balance found for collateral`);
    }

    // Step 1: Get quote
    verbose('Fetching Loopscale borrow quote...');
    const quote = await loopscaleFetch('/markets/quote/max', {
      principalMint: borrowMeta.mint,
      collateralMint: collateralMeta.mint,
      collateralAmount: collateralBalance.balance,
      durationIndex: 0, // 1-day term
    }, signer.address);

    const quoteApy = parseFloat(quote.apy ?? '0');
    verbose(`Loopscale borrow quote: ${(quoteApy * 100).toFixed(2)}% APY (1-day, auto-refinances)`);

    // Step 2: Execute flash borrow
    const resp = await loopscaleFetch('/markets/creditbook/flash_borrow', {
      principalMint: borrowMeta.mint,
      principalAmount: rawAmount,
      collateralMint: collateralMeta.mint,
      collateralAmount: collateralBalance.balance,
      durationIndex: 0,
    }, signer.address);

    // May return single tx or array of txs
    const txs: string[] = Array.isArray(resp.transactions ?? resp.txs)
      ? (resp.transactions ?? resp.txs)
      : [resp.transaction ?? resp.tx];

    if (!txs[0]) throw new Error('Loopscale API did not return a transaction');

    const prices = await getPrices([borrowMeta.mint]);
    const price = prices.get(borrowMeta.mint)?.priceUsd;

    const signature = await signAndSendLoopscaleTxs(txs, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: borrowMeta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    const { explorerUrl } = await import('../../utils/solana.js');

    return {
      signature,
      protocol: 'loopscale',
      explorerUrl: explorerUrl(signature),
    };
  }

  async repay(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const isMax = !isFinite(amount);

    // Find active loan for this token
    const loans = await loopscaleFetch('/markets/loans/info', {
      borrowers: [signer.address],
      filterType: 0, // Active
    }, signer.address);

    const loan = loans.find((l: any) =>
      (l.principalMint ?? l.principal_mint) === meta.mint
    );
    if (!loan) throw new Error(`No active Loopscale loan found for ${meta.symbol}`);

    const loanAddress = loan.address ?? loan.loanAddress ?? loan.loan_address;

    const body: Record<string, any> = {
      loanAddress,
    };

    if (isMax) {
      body.repayAll = true;
      body.closeIfPossible = true;
    } else {
      body.amount = uiToTokenAmount(amount, meta.decimals).toString();
    }

    const resp = await loopscaleFetch('/markets/creditbook/repay', body, signer.address);

    // May return single tx or array of txs
    const txs: string[] = Array.isArray(resp.transactions ?? resp.txs)
      ? (resp.transactions ?? resp.txs)
      : [resp.transaction ?? resp.tx];

    if (!txs[0]) throw new Error('Loopscale API did not return a transaction');

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = isMax ? '0' : uiToTokenAmount(amount, meta.decimals).toString();

    const signature = await signAndSendLoopscaleTxs(txs, signer, {
      txType: 'lend-repay',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    const { explorerUrl } = await import('../../utils/solana.js');

    // Calculate remaining debt
    const decimals = meta.decimals;
    const mintFactor = Math.pow(10, decimals);
    const loanPrincipal = parseFloat(
      loan.principalAmount ?? loan.principal_amount ??
      loan.ledger?.principalAmount ?? loan.ledger?.principal_amount ?? '0'
    ) / mintFactor;
    const repaidAmount = isMax ? loanPrincipal : amount;
    const remainingDebt = Math.max(0, loanPrincipal - repaidAmount);

    return {
      signature,
      protocol: 'loopscale',
      explorerUrl: explorerUrl(signature),
      remainingDebt: isMax ? 0 : remainingDebt,
    };
  }
}
