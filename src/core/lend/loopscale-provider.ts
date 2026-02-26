import {
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  address as toAddress,
} from '@solana/kit';
import { loadSigner } from '../wallet-manager.js';
import { resolveToken, type TokenMetadata } from '../token-registry.js';
import { sendEncodedTransaction } from '../transaction.js';
import { getPrices } from '../price-service.js';
import { getTokenBalances } from '../token-service.js';
import { verbose } from '../../output/formatter.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';

// ── Constants ────────────────────────────────────────────

const LOOPSCALE_BASE_URL = 'https://tars.loopscale.com/v1';
const VAULT_CACHE_TTL_MS = 60_000;
const SECONDS_PER_YEAR = 31_536_000;
/** Loopscale APY values use 1_000_000 = 100% */
const APY_DIVISOR = 1_000_000;

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

/** Resolve a mint address to a symbol via the token registry. */
async function symbolForMint(mint: string): Promise<string> {
  const meta = await resolveToken(mint);
  return meta?.symbol ?? '';
}

// ── Vault cache ──────────────────────────────────────────

interface VaultInfo {
  address: string;
  principalMint: string;
  symbol: string;
  decimals: number;
  depositApy: number;   // decimal: 0.05 = 5%
  borrowApy: number;    // decimal: realized weighted-avg borrow rate
  totalDeposited: number; // UI amount
  totalBorrowed: number;  // UI amount
  utilizationPct: number;
  lpSupply: bigint;
}

/** Raw API response shape for a single vault entry */
interface RawVaultEntry {
  vault: {
    address: string;
    principalMint: string;
    lpMint: string;
    lpSupply: string;
    depositsEnabled: boolean;
  };
  vaultMetadata: {
    name: string;
  };
  vaultStrategy: {
    strategy: {
      interestPerSecond: number;
      currentDeployedAmount: string;
      externalYieldAmount: string;
      tokenBalance: string;
    };
    externalYieldInfo?: {
      apy: string;
    } | null;
    terms?: {
      assetTerms?: Record<string, {
        durationAndApys?: [{ duration: number; durationType: number }, number][];
      }>;
    };
  };
}

let vaultCache: VaultInfo[] = [];
let vaultCacheTs = 0;

async function fetchVaults(): Promise<VaultInfo[]> {
  if (Date.now() - vaultCacheTs < VAULT_CACHE_TTL_MS && vaultCache.length > 0) {
    return vaultCache;
  }

  const data = await loopscaleFetch('/markets/lending_vaults/info', {
    page: 0,
    pageSize: 50,
  });

  const entries: RawVaultEntry[] = data.lendVaults ?? [];
  const vaults: VaultInfo[] = [];

  // Collect all mints so we can resolve symbols in one pass
  const mintSet = new Set<string>();
  for (const e of entries) mintSet.add(e.vault.principalMint);
  const symbolMap = new Map<string, string>();
  await Promise.all([...mintSet].map(async mint => {
    const sym = await symbolForMint(mint);
    if (sym) symbolMap.set(mint, sym);
  }));

  for (const e of entries) {
    if (!e.vault.depositsEnabled) continue;

    const principalMint = e.vault.principalMint;
    const symbol = symbolMap.get(principalMint) ?? e.vaultMetadata.name ?? '';
    // Infer decimals from token registry, or fallback to 6 for common stables
    const meta = await resolveToken(principalMint);
    const decimals = meta?.decimals ?? 6;
    const mintFactor = Math.pow(10, decimals);

    const strat = e.vaultStrategy.strategy;
    const ips = strat.interestPerSecond;
    const deployed = parseFloat(strat.currentDeployedAmount);
    const extYieldAmt = parseFloat(strat.externalYieldAmount);
    const tokenBalance = parseFloat(strat.tokenBalance);
    const lpSupply = BigInt(e.vault.lpSupply);

    const totalAssets = deployed + extYieldAmt + tokenBalance;
    if (totalAssets <= 0) continue;

    // Deposit APY = lending yield + external yield, pro-rated to total assets
    const lendingYieldPerYear = ips * SECONDS_PER_YEAR;
    const lendingApy = lendingYieldPerYear / totalAssets;

    const extApyRaw = parseFloat(e.vaultStrategy.externalYieldInfo?.apy ?? '0');
    const extApy = extApyRaw / APY_DIVISOR; // decimal
    const extApyContribution = extYieldAmt > 0 ? (extYieldAmt * extApy) / totalAssets : 0;

    const depositApy = lendingApy + extApyContribution;

    // Borrow APY: realized rate from deployed capital
    const borrowApy = deployed > 0 ? (ips * SECONDS_PER_YEAR) / deployed : 0;

    const totalDeposited = totalAssets / mintFactor;
    const totalBorrowed = deployed / mintFactor;
    const utilizationPct = totalAssets > 0 ? (deployed / totalAssets) * 100 : 0;

    vaults.push({
      address: e.vault.address,
      principalMint,
      symbol,
      decimals,
      depositApy,
      borrowApy,
      totalDeposited,
      totalBorrowed,
      utilizationPct,
      lpSupply,
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

interface UserVaultPosition {
  vaultAddress: string;
  mint: string;
  vaultLpBalance: number;
}

/** Fetch user's deposit positions via the lending_vaults/user endpoint. */
async function getUserVaultPositions(walletAddress: string): Promise<UserVaultPosition[]> {
  const resp = await loopscaleFetch('/markets/lending_vaults/user', {
    page: 0,
    pageSize: 50,
  }, walletAddress);

  return (resp.positions ?? []).map((p: any) => ({
    vaultAddress: p.vault,
    mint: p.mint,
    vaultLpBalance: p.vaultLpBalance ?? 0,
  }));
}

/** Convert an LP token balance to the underlying principal amount. */
function lpToUnderlying(lpBalance: number, vault: VaultInfo): number {
  if (vault.lpSupply <= 0n) return 0;
  const mintFactor = Math.pow(10, vault.decimals);
  const totalAssetsRaw = vault.totalDeposited * mintFactor; // raw units
  return (lpBalance * totalAssetsRaw) / Number(vault.lpSupply) / mintFactor;
}

// ── Transaction signing ──────────────────────────────────

/**
 * Loopscale returns transactions as { message: base64, signatures: [{publicKey, signature}] }.
 * The `message` is the base64-encoded compiled versioned transaction message.
 *
 * IMPORTANT: We must keep the original message bytes unchanged — co-signer
 * signatures were computed over those exact bytes. Decompiling and recompiling
 * would alter the bytes and invalidate them.
 */
async function signAndSendLoopscaleTx(
  txObj: { message: string; signatures?: { publicKey: string; signature: string }[] },
  signer: any,
  txOpts?: Parameters<typeof sendEncodedTransaction>[1],
): Promise<string> {
  const msgBytes = new Uint8Array(Buffer.from(txObj.message, 'base64'));

  // Decode the compiled message header to discover signer addresses
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(msgBytes);
  const numSigners = compiledMsg.header.numSignerAccounts;
  const signerAddresses = compiledMsg.staticAccounts.slice(0, numSigners);

  verbose(`Loopscale tx: ${numSigners} signers required: ${signerAddresses.join(', ')}`);

  // Initialize all signature slots to null (64 zero bytes)
  const nullSig = new Uint8Array(64);
  const signatures: Record<string, Uint8Array> = {};
  for (const addr of signerAddresses) {
    signatures[addr] = nullSig;
  }

  // Fill co-signer signatures from the API response
  if (txObj.signatures?.length) {
    for (const s of txObj.signatures) {
      const addr = toAddress(s.publicKey);
      if (addr in signatures) {
        signatures[addr] = new Uint8Array(Buffer.from(s.signature, 'base64'));
        verbose(`Loopscale co-signer: ${addr}`);
      }
    }
  }

  // Build transaction from original message bytes + signatures
  const tx = Object.freeze({
    messageBytes: msgBytes as any,
    signatures: Object.freeze(signatures),
  });

  // Sign with our keypair (matches by public key against signature slots)
  const signedTx = await partiallySignTransaction([signer.keyPair], tx as any);
  const encoded = getBase64EncodedWireTransaction(signedTx as any);

  const result = await sendEncodedTransaction(encoded, txOpts);
  return result.signature;
}

/**
 * Some Loopscale operations (borrow, repay) return multiple transactions
 * that must be sent sequentially. Returns the last signature.
 */
async function signAndSendLoopscaleTxs(
  transactions: { message: string; signatures?: any[] }[],
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

    // Deduplicate: keep highest deposit APY per mint (multiple vaults per token)
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

    // Fetch user deposits, loans, and vault info in parallel
    const [userVaultPositions, loansResp, vaults] = await Promise.all([
      getUserVaultPositions(walletAddress).catch(() => []),
      loopscaleFetch('/markets/loans/info', {
        borrowers: [walletAddress],
        filterType: 0, // Active loans only
        page: 0,
        pageSize: 50,
      }).catch(() => ({ loanInfos: [] })),
      fetchVaults(),
    ]);

    const loans = loansResp.loanInfos ?? [];

    // Collect mints for price lookup
    const mints = new Set<string>();
    for (const up of userVaultPositions) {
      if (up.vaultLpBalance > 0) mints.add(up.mint);
    }
    for (const loan of loans) {
      const ledger = loan.ledgers?.[0];
      if (ledger?.principalMint) mints.add(ledger.principalMint);
    }

    const prices = mints.size > 0 ? await getPrices([...mints]) : new Map();

    // Map vault LP positions to deposit positions
    for (const up of userVaultPositions) {
      if (up.vaultLpBalance <= 0) continue;
      const vault = vaults.find(v => v.address === up.vaultAddress);
      if (!vault) continue;

      const amount = lpToUnderlying(up.vaultLpBalance, vault);
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

    // Map loans to borrow positions
    for (const loanInfo of loans) {
      const ledger = loanInfo.ledgers?.[0];
      if (!ledger) continue;

      const principalMint = ledger.principalMint;
      if (!principalMint) continue;

      const meta = await resolveToken(principalMint);
      const decimals = meta?.decimals ?? 6;
      const mintFactor = Math.pow(10, decimals);
      const symbol = meta?.symbol ?? 'unknown';

      const rawAmount = ledger.principalDue ?? 0;
      const amount = rawAmount / mintFactor;
      if (amount <= 0) continue;

      const apy = (ledger.apy ?? 0) / APY_DIVISOR; // decimal
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
      vault: vault.address,
      principalAmount: Number(rawAmount),
      minLpAmount: 0,
    }, signer.address);

    const txObj = resp.transaction;
    if (!txObj?.message) throw new Error('Loopscale API did not return a transaction');

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const signature = await signAndSendLoopscaleTx(txObj, signer, {
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

    // Find the vault the user actually has a deposit in
    const [vaults, userPositions] = await Promise.all([
      fetchVaults(),
      getUserVaultPositions(signer.address).catch(() => []),
    ]);
    const userPos = userPositions.find(p => p.mint === meta.mint && p.vaultLpBalance > 0);
    const vault = userPos
      ? vaults.find(v => v.address === userPos.vaultAddress)
      : findBestVault(vaults, meta.mint);
    if (!vault) throw new Error(`No Loopscale vault found for ${meta.symbol}`);

    const isMax = !isFinite(amount);
    const body: Record<string, any> = {
      vault: vault.address,
    };

    if (isMax) {
      body.withdrawAll = true;
      body.maxAmountLp = Number.MAX_SAFE_INTEGER;
      body.amountPrincipal = 0;
    } else {
      body.amountPrincipal = Number(uiToTokenAmount(amount, meta.decimals));
      body.maxAmountLp = Number.MAX_SAFE_INTEGER;
    }

    const resp = await loopscaleFetch('/markets/lending_vaults/withdraw', body, signer.address);

    const txObj = resp.transaction;
    if (!txObj?.message) throw new Error('Loopscale API did not return a transaction');

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const rawAmount = isMax ? '0' : uiToTokenAmount(amount, meta.decimals).toString();

    const signature = await signAndSendLoopscaleTx(txObj, signer, {
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
    const rawAmount = Number(uiToTokenAmount(amount, borrowMeta.decimals));

    // Get collateral balance
    const balances = await getTokenBalances(signer.address);
    const collateralBalance = balances.find(b => b.mint === collateralMeta.mint);
    if (!collateralBalance || parseFloat(collateralBalance.balance) <= 0) {
      throw new Error(`No ${collateralMeta.symbol} balance found for collateral`);
    }
    const collateralRaw = Number(collateralBalance.balance);

    // Step 1: Get quote to discover strategy, APY, and LQT
    verbose('Fetching Loopscale borrow quote...');
    const quotes = await loopscaleFetch('/markets/quote/max', {
      principalMint: borrowMeta.mint,
      collateralFilter: [{
        mint: collateralMeta.mint,
        amount: collateralRaw,
        assetData: { Spl: { mint: collateralMeta.mint } },
      }],
      duration: 1,
      durationType: 0, // days
      durationIndex: 0,
    }, signer.address);

    const quoteList = Array.isArray(quotes) ? quotes : [];
    if (quoteList.length === 0) {
      throw new Error(`No Loopscale borrow quotes available for ${borrowMeta.symbol} against ${collateralMeta.symbol}`);
    }

    const bestQuote = quoteList[0];
    const quoteApy = (bestQuote.apy ?? 0) / APY_DIVISOR;
    verbose(`Loopscale borrow quote: ${(quoteApy * 100).toFixed(2)}% APY (1-day, auto-refinances)`);

    // Calculate collateral needed based on LTV and prices
    const ltv = bestQuote.ltv / 1_000_000; // decimal, e.g. 0.8
    const priceMints = [borrowMeta.mint, collateralMeta.mint];
    const prices = await getPrices(priceMints);
    const borrowPrice = prices.get(borrowMeta.mint)?.priceUsd ?? 0;
    const collateralPrice = prices.get(collateralMeta.mint)?.priceUsd ?? 0;
    if (!borrowPrice || !collateralPrice) {
      throw new Error('Cannot determine prices for collateral calculation');
    }

    const borrowValueUsd = amount * borrowPrice;
    const minCollateralUsd = borrowValueUsd / ltv;
    const collateralDecimals = collateralMeta.decimals;
    const minCollateralRaw = Math.ceil(
      (minCollateralUsd / collateralPrice) * Math.pow(10, collateralDecimals) * 1.5 // 50% buffer
    );

    // Cap to available balance minus fee reserve (0.01 SOL for native SOL)
    const FEE_RESERVE = 10_000_000; // 0.01 SOL in lamports
    const maxCollateral = collateralMeta.mint === 'So11111111111111111111111111111111111111112'
      ? Math.max(0, collateralRaw - FEE_RESERVE)
      : collateralRaw;
    const collateralForBorrow = Math.min(minCollateralRaw, maxCollateral);
    if (collateralForBorrow <= 0) {
      throw new Error(`Insufficient ${collateralMeta.symbol} for collateral`);
    }
    verbose(`Collateral: ${collateralForBorrow} raw units (min ${minCollateralRaw} for ${amount} ${borrowMeta.symbol} at ${(ltv * 100).toFixed(0)}% LTV)`);

    // Step 2: Execute flash borrow
    const resp = await loopscaleFetch('/markets/creditbook/flash_borrow', {
      principalRequested: [{
        ledgerIndex: 0,
        principalAmount: rawAmount,
        principalMint: borrowMeta.mint,
        strategy: bestQuote.strategy,
        durationIndex: 0,
        expectedLoanValues: {
          expectedApy: bestQuote.apy,
          expectedLqt: [bestQuote.lqt, 0, 0, 0, 0],
        },
      }],
      depositCollateral: [{
        collateralAmount: collateralForBorrow,
        collateralAssetData: { Spl: { mint: collateralMeta.mint } },
      }],
    }, signer.address);

    // Response contains transactions array of {message, signatures} objects
    const txs = resp.transactions ?? [];
    verbose(`Loopscale borrow returned ${txs.length} transaction(s)`);
    if (txs.length === 0 || !txs[0]?.message) {
      throw new Error('Loopscale API did not return a transaction');
    }

    const price = borrowPrice;

    const signature = await signAndSendLoopscaleTxs(txs, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: borrowMeta.mint,
      toAmount: String(rawAmount),
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
    const loansResp = await loopscaleFetch('/markets/loans/info', {
      borrowers: [signer.address],
      filterType: 0, // Active
      page: 0,
      pageSize: 50,
    }, signer.address);

    const loans = loansResp.loanInfos ?? [];
    const loanInfo = loans.find((l: any) =>
      l.ledgers?.[0]?.principalMint === meta.mint
    );
    if (!loanInfo) throw new Error(`No active Loopscale loan found for ${meta.symbol}`);

    const loanAddress = loanInfo.loan.address;
    const ledger = loanInfo.ledgers[0];

    const repayAmount = isMax
      ? (ledger.principalDue ?? 0) + (ledger.interestOutstanding ?? 0)
      : Number(uiToTokenAmount(amount, meta.decimals));

    const resp = await loopscaleFetch('/markets/creditbook/repay', {
      loan: loanAddress,
      repayParams: [{
        amount: repayAmount,
        ledgerIndex: ledger.ledgerIndex ?? 0,
        repayAll: isMax,
      }],
      collateralWithdrawalParams: [],
      closeIfPossible: isMax,
    }, signer.address);

    const txs = resp.transactions ?? [];

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
    const mintFactor = Math.pow(10, meta.decimals);
    const loanPrincipal = (ledger.principalDue ?? 0) / mintFactor;
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
