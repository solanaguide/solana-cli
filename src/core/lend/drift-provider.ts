import {
  DriftClient,
  BulkAccountLoader,
  initialize,
  calculateBorrowRate,
  calculateDepositRate,
  calculateUtilization,
  convertToNumber,
  SPOT_MARKET_RATE_PRECISION,
  SPOT_MARKET_UTILIZATION_PRECISION,
  QUOTE_PRECISION,
  type SpotMarketAccount,
} from '@drift-labs/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getV1Connection, DummyWallet, toV2Instructions } from './drift-compat.js';
import { loadSigner } from '../wallet-manager.js';
import { resolveToken, type TokenMetadata } from '../token-registry.js';
import { getPrices } from '../price-service.js';
import { buildAndSendTransaction } from '../transaction.js';
import { verbose } from '../../output/formatter.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';

// ── Client caching ───────────────────────────────────────

let cachedClient: DriftClient | null = null;
let clientLoadedAt = 0;
const CLIENT_TTL_MS = 60_000;

async function loadDriftClient(walletAddress?: string): Promise<DriftClient> {
  const now = Date.now();
  if (cachedClient && (now - clientLoadedAt) < CLIENT_TTL_MS && !walletAddress) {
    return cachedClient;
  }

  // Unsubscribe old client
  if (cachedClient && walletAddress) {
    try { await cachedClient.unsubscribe(); } catch { /* ok */ }
  }

  verbose('Loading Drift client...');
  const connection = getV1Connection();

  // DummyWallet for account derivation — signing done via our v2 pipeline
  const wallet = walletAddress
    ? new DummyWallet(walletAddress)
    : new DummyWallet(Keypair.generate().publicKey.toBase58());

  initialize({ env: 'mainnet-beta' as any });

  const accountLoader = new BulkAccountLoader(connection as any, 'confirmed', 30_000);

  const client = new DriftClient({
    connection: connection as any,
    wallet: wallet as any,
    env: 'mainnet-beta',
    accountSubscription: {
      type: 'polling',
      accountLoader,
    },
  });

  await client.subscribe();

  // Unref the polling timer so it doesn't prevent process exit
  if (accountLoader.intervalId) {
    (accountLoader.intervalId as any).unref?.();
  }

  if (!walletAddress) {
    cachedClient = client;
    clientLoadedAt = now;
  }

  return client;
}

// ── Helpers ───────────────────────────────────────────────

async function resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
  const meta = await resolveToken(symbolOrMint);
  if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
  return meta;
}

function findSpotMarketByMint(client: DriftClient, mint: string): SpotMarketAccount | undefined {
  const markets = client.getSpotMarketAccounts();
  return markets.find(m => m.mint.toBase58() === mint);
}

function getTokenAmountUi(amount: BN, decimals: number): number {
  return convertToNumber(amount, new BN(10 ** decimals));
}

function marketName(market: SpotMarketAccount): string {
  return String.fromCharCode(...(market as any).name.filter((c: number) => c !== 0)).trim();
}

// ── Provider ─────────────────────────────────────────────

export class DriftProvider implements LendProvider {
  name = 'drift' as const;
  capabilities = { deposit: true, withdraw: true, borrow: true, repay: true };

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const client = await loadDriftClient();
    const markets = client.getSpotMarketAccounts();
    const rates: LendingRate[] = [];

    for (const market of markets) {
      const symbol = marketName(market);
      if (!symbol) continue;

      if (tokens && tokens.length > 0) {
        const match = tokens.some(t =>
          t.toUpperCase() === symbol.toUpperCase() ||
          t === market.mint.toBase58()
        );
        if (!match) continue;
      }

      const borrowRate = calculateBorrowRate(market);
      const depositRate = calculateDepositRate(market);
      const utilization = calculateUtilization(market);
      const mintFactor = new BN(10 ** market.decimals);

      // Get token amounts using cumulative interest
      const depositPrecision = new BN(10).pow(new BN(19 - market.decimals));
      const totalDeposited = market.depositBalance.mul(market.cumulativeDepositInterest).div(depositPrecision);
      const totalBorrowed = market.borrowBalance.mul(market.cumulativeBorrowInterest).div(depositPrecision);

      rates.push({
        protocol: 'drift',
        token: symbol,
        mint: market.mint.toBase58(),
        depositApy: convertToNumber(depositRate, SPOT_MARKET_RATE_PRECISION),
        borrowApy: convertToNumber(borrowRate, SPOT_MARKET_RATE_PRECISION),
        totalDeposited: getTokenAmountUi(totalDeposited, market.decimals),
        totalBorrowed: getTokenAmountUi(totalBorrowed, market.decimals),
        utilizationPct: convertToNumber(utilization, SPOT_MARKET_UTILIZATION_PRECISION) * 100,
      });
    }

    return rates;
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    verbose(`Fetching Drift positions for ${walletAddress}`);
    const client = await loadDriftClient(walletAddress);

    const user = client.getUser();
    // Check if this wallet has a Drift account
    try {
      if (!(await user.exists())) return [];
    } catch {
      return [];
    }

    const spots = user.getActiveSpotPositions();
    if (spots.length === 0) return [];

    const positions: LendingPosition[] = [];
    let healthFactor: number | undefined;

    try {
      const health = user.getHealth();
      // Drift health: 0-100 (100 = safe). Convert to ratio where > 1 is safe.
      healthFactor = health > 0 ? health / 50 : undefined; // approximate: 100 → 2.0
    } catch { /* ok */ }

    for (const pos of spots) {
      const market = client.getSpotMarketAccount(pos.marketIndex);
      if (!market) continue;

      const amount = user.getTokenAmount(pos.marketIndex);
      const symbol = marketName(market);
      const absAmount = getTokenAmountUi(amount.abs(), market.decimals);
      if (absAmount <= 0) continue;

      const isDeposit = amount.gt(new BN(0));

      // Get USD value via oracle
      let valueUsd = 0;
      try {
        const oracleData = client.getOracleDataForSpotMarket(pos.marketIndex);
        const price = convertToNumber(oracleData.price, new BN(10 ** 6));
        valueUsd = absAmount * price;
      } catch { /* ok */ }

      const interestRate = isDeposit
        ? calculateDepositRate(market)
        : calculateBorrowRate(market);

      positions.push({
        protocol: 'drift',
        token: symbol,
        mint: market.mint.toBase58(),
        type: isDeposit ? 'deposit' : 'borrow',
        amount: absAmount,
        valueUsd,
        apy: convertToNumber(interestRate, SPOT_MARKET_RATE_PRECISION),
        healthFactor: isDeposit ? undefined : healthFactor,
      });
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadDriftClient(signer.address);

    const market = findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);

    // Check if user account exists — getUser() throws if no subscription
    let userExists = false;
    try {
      const user = client.getUser();
      userExists = await user.exists();
    } catch { /* no user — first time */ }

    if (!userExists) {
      verbose('No Drift account — including init instructions');
      const { ixs: initAndDepositIxs } = await client.createInitializeUserAccountAndDepositCollateralIxs(
        rawAmount,
        await client.getAssociatedTokenAccount(market.marketIndex),
        market.marketIndex,
        0,         // subAccountId
        undefined, // name
        undefined, // fromSubAccountId
        undefined, // referrerInfo
        undefined, // donateAmount
        undefined, // customMaxMarginRatio
        (market as any).poolId, // match user pool to market pool
      );
      const v2Ixs = toV2Instructions(initAndDepositIxs);
      const prices = await getPrices([meta.mint]);
      const price = prices.get(meta.mint)?.priceUsd;
      const rawAmountStr = uiToTokenAmount(amount, meta.decimals).toString();
      const result = await buildAndSendTransaction(v2Ixs, signer, {
        txType: 'lend-deposit',
        walletName,
        fromMint: meta.mint,
        fromAmount: rawAmountStr,
        fromPriceUsd: price,
      });
      return {
        signature: result.signature,
        protocol: 'drift',
        explorerUrl: result.explorerUrl,
      };
    }

    const ata = await client.getAssociatedTokenAccount(market.marketIndex);
    const ix = await client.getDepositInstruction(rawAmount, market.marketIndex, ata);
    const instructions = toV2Instructions([ix]);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmountStr,
      fromPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadDriftClient(signer.address);

    const market = findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const withdrawAll = !isFinite(amount);
    let rawAmount: BN;

    if (withdrawAll) {
      // Withdraw entire deposit
      const tokenAmount = client.getUser().getTokenAmount(market.marketIndex);
      rawAmount = tokenAmount.abs();
    } else {
      rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);
    }

    const ata = await client.getAssociatedTokenAccount(market.marketIndex);
    const ix = await client.getWithdrawIx(rawAmount, market.marketIndex, ata, true);
    const instructions = toV2Instructions([ix]);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmountStr,
      toPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
    };
  }

  async borrow(walletName: string, token: string, amount: number, _collateral: string): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadDriftClient(signer.address);

    const market = findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);
    const ata = await client.getAssociatedTokenAccount(market.marketIndex);

    // Withdraw without reduceOnly=true allows borrowing
    const ix = await client.getWithdrawIx(rawAmount, market.marketIndex, ata, false);
    const instructions = toV2Instructions([ix]);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmountStr,
      toPriceUsd: price,
    });

    // Fetch health (best-effort)
    let healthFactor: number | undefined;
    try {
      const user = client.getUser();
      const health = user.getHealth();
      healthFactor = health > 0 ? health / 50 : undefined;
    } catch { /* ok */ }

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
      healthFactor,
    };
  }

  async repay(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadDriftClient(signer.address);

    const market = findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const repayAll = !isFinite(amount);
    let rawAmount: BN;

    if (repayAll) {
      const tokenAmount = client.getUser().getTokenAmount(market.marketIndex);
      rawAmount = tokenAmount.abs();
    } else {
      rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);
    }

    const ata = await client.getAssociatedTokenAccount(market.marketIndex);
    const ix = await client.getDepositInstruction(rawAmount, market.marketIndex, ata, undefined, true);
    const instructions = toV2Instructions([ix]);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-repay',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmountStr,
      fromPriceUsd: price,
    });

    // Remaining debt
    let remainingDebt: number | undefined;
    try {
      const user = client.getUser();
      const tokenAmount = user.getTokenAmount(market.marketIndex);
      if (tokenAmount.lt(new BN(0))) {
        remainingDebt = getTokenAmountUi(tokenAmount.abs(), market.decimals);
      } else {
        remainingDebt = 0;
      }
    } catch { /* ok */ }

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
      remainingDebt,
    };
  }
}
