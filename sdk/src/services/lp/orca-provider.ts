import { type Address, type Instruction, address } from '@solana/kit';
import {
  setWhirlpoolsConfig,
  fetchPositionsForOwner,
  openPositionInstructions,
  increaseLiquidityInstructions,
  closePositionInstructions,
  decreaseLiquidityInstructions,
  harvestPositionInstructions,
  createConcentratedLiquidityPoolInstructions,
  type IncreaseLiquidityQuoteParam,
  type DecreaseLiquidityQuoteParam,
} from '@orca-so/whirlpools';
import { fetchWhirlpool, fetchPosition, getPositionAddress } from '@orca-so/whirlpools-client';
import {
  sqrtPriceToPrice,
  tickIndexToPrice,
} from '@orca-so/whirlpools-core';
import { tokenAmountToUi, uiToTokenAmount } from '../../utils/solana.js';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';
import type {
  LpProvider,
  LpProviderCapabilities,
  LpPoolInfo,
  LpPositionInfo,
  LpDepositParams,
  LpDepositQuote,
  LpWithdrawParams,
  LpWriteResult,
  CreatePoolParams,
  PoolConfig,
} from './lp-provider.js';

// ── Orca API types ────────────────────────────────────────

const ORCA_POOL_API = 'https://api.orca.so/v2/solana/pools';

interface OrcaApiPoolV2 {
  address: string;
  tokenA: { address: string; symbol: string; decimals: number; name: string };
  tokenB: { address: string; symbol: string; decimals: number; name: string };
  tickSpacing: number;
  price: number;
  feeRate: number;
  tvlUsdc: number;
  volume24hUsdc: number;
  yield24hUsdc: number;
  totalApr24h: number;
  feeApr24h: number;
  rewardApr24h: number;
}

// ── Dependency bundle ───────────────────────────────────────

export interface OrcaLpDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
}

// ── Provider ────────────────────────────────────────────────

export class OrcaLpProvider implements LpProvider {
  name = 'orca' as const;
  capabilities: LpProviderCapabilities = {
    pools: true,
    positions: true,
    deposit: true,
    withdraw: true,
    claimFees: true,
    createPool: true,
    farming: false,
    closePosition: true,
  };

  private ctx: SolContext;
  private deps: OrcaLpDeps;
  private configInitialized = false;

  constructor(ctx: SolContext, deps: OrcaLpDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  // ── SDK initialization ──────────────────────────────────

  private async ensureConfig(): Promise<void> {
    if (this.configInitialized) return;
    await setWhirlpoolsConfig('solanaMainnet');
    this.configInitialized = true;
  }

  // ── Helpers ─────────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  // ── Pool API (filtered, no cache needed — responses are small) ──

  private mapOrcaPool(p: OrcaApiPoolV2): LpPoolInfo {
    return {
      poolId: p.address,
      protocol: 'orca',
      poolType: 'clmm' as const,
      tokenA: p.tokenA.symbol,
      tokenB: p.tokenB.symbol,
      mintA: p.tokenA.address,
      mintB: p.tokenB.address,
      tvlUsd: p.tvlUsdc || null,
      volume24hUsd: p.volume24hUsdc || null,
      feeRate: p.feeRate,
      apy: p.totalApr24h || null,
      currentPrice: p.price,
      tickSpacing: p.tickSpacing,
    };
  }

  // ── LpProvider: getPools ──────────────────────────────────

  async getPools(tokenA?: string, tokenB?: string, limit?: number): Promise<LpPoolInfo[]> {
    try {
      // Resolve token filters to mint addresses
      let mintA: string | undefined;
      let mintB: string | undefined;
      if (tokenA) {
        const meta = await this.deps.registry.resolveToken(tokenA);
        mintA = meta?.mint ?? tokenA;
      }
      if (tokenB) {
        const meta = await this.deps.registry.resolveToken(tokenB);
        mintB = meta?.mint ?? tokenB;
      }

      const pageSize = Math.min(limit ?? 50, 100);
      let url: string;

      if (mintA && mintB) {
        // Both tokens: use tokensBothOf filter
        url = `${ORCA_POOL_API}?tokensBothOf=${mintA},${mintB}&sortBy=tvl&size=${pageSize}`;
      } else if (mintA || mintB) {
        // Single token filter
        url = `${ORCA_POOL_API}?token=${mintA || mintB}&sortBy=tvl&size=${pageSize}`;
      } else {
        // Browse: top pools by TVL, require minimum TVL to avoid noise
        url = `${ORCA_POOL_API}?sortBy=tvl&size=${pageSize}&minTvl=10000`;
      }

      this.ctx.logger.verbose(`Fetching Orca pools: ${url}`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Orca API error ${resp.status}`);

      const data: OrcaApiPoolV2[] = await resp.json();

      const results = data.map(p => this.mapOrcaPool(p));
      results.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));

      return limit ? results.slice(0, limit) : results;
    } catch (err: any) {
      this.ctx.logger.verbose(`Orca getPools failed: ${err.message}`);
      return [];
    }
  }

  // ── LpProvider: getPositions ──────────────────────────────

  async getPositions(walletAddress: string): Promise<LpPositionInfo[]> {
    await this.ensureConfig();

    if (!walletAddress) return [];

    try {
      this.ctx.logger.verbose(`Fetching Orca positions for ${walletAddress}`);

      const positionsData = await fetchPositionsForOwner(
        this.ctx.rpc,
        address(walletAddress),
      );

      if (positionsData.length === 0) return [];

      // Flatten position bundles into individual positions
      const allPositions: any[] = [];
      for (const posData of positionsData) {
        if (posData.isPositionBundle) {
          allPositions.push(...posData.positions);
        } else {
          allPositions.push(posData);
        }
      }

      // Build position info in parallel
      const results = await Promise.allSettled(
        allPositions.map(pos => this.buildPositionInfo(pos)),
      );

      const positions: LpPositionInfo[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          positions.push(r.value);
        } else if (r.status === 'rejected') {
          this.ctx.logger.verbose(`Skipping Orca position: ${r.reason?.message ?? r.reason}`);
        }
      }

      return positions;
    } catch (err: any) {
      this.ctx.logger.verbose(`Orca getPositions failed: ${err.message}`);
      return [];
    }
  }

  private async buildPositionInfo(
    pos: { address: Address; data: { whirlpool: Address; positionMint: Address; liquidity: bigint; tickLowerIndex: number; tickUpperIndex: number; feeOwedA: bigint; feeOwedB: bigint } },
  ): Promise<LpPositionInfo | null> {
    const positionData = pos.data;
    if (positionData.liquidity === 0n) return null;

    const poolAddress = positionData.whirlpool;
    const pool = await fetchWhirlpool(this.ctx.rpc, poolAddress);
    const poolData = pool.data;

    const mintA = String(poolData.tokenMintA);
    const mintB = String(poolData.tokenMintB);

    const [metaA, metaB] = await Promise.all([
      this.deps.registry.resolveToken(mintA),
      this.deps.registry.resolveToken(mintB),
    ]);

    const decimalsA = metaA?.decimals ?? 9;
    const decimalsB = metaB?.decimals ?? 6;
    if (!metaA?.decimals || !metaB?.decimals) {
      this.ctx.logger.verbose(`Using fallback decimals for ${!metaA?.decimals ? mintA : mintB}`);
    }

    const currentPrice = sqrtPriceToPrice(poolData.sqrtPrice, decimalsA, decimalsB);
    const lowerPrice = tickIndexToPrice(positionData.tickLowerIndex, decimalsA, decimalsB);
    const upperPrice = tickIndexToPrice(positionData.tickUpperIndex, decimalsA, decimalsB);

    const inRange =
      poolData.tickCurrentIndex >= positionData.tickLowerIndex &&
      poolData.tickCurrentIndex < positionData.tickUpperIndex;

    // Estimate token amounts from liquidity and tick range
    const { amountA, amountB } = this.estimateTokenAmounts(
      positionData.liquidity,
      poolData.sqrtPrice,
      positionData.tickLowerIndex,
      positionData.tickUpperIndex,
      decimalsA,
      decimalsB,
    );

    // Unclaimed fees
    const unclaimedFeesA = tokenAmountToUi(positionData.feeOwedA, decimalsA);
    const unclaimedFeesB = tokenAmountToUi(positionData.feeOwedB, decimalsB);

    // Enrich with USD prices
    const prices = await this.deps.price.getPrices([mintA, mintB]);
    const priceA = prices.get(mintA)?.priceUsd ?? 0;
    const priceB = prices.get(mintB)?.priceUsd ?? 0;

    const valueUsd = amountA * priceA + amountB * priceB;
    const unclaimedFeesUsd = unclaimedFeesA * priceA + unclaimedFeesB * priceB;

    return {
      positionId: String(positionData.positionMint),
      poolId: String(poolAddress),
      protocol: 'orca',
      poolType: 'clmm',
      tokenA: metaA?.symbol ?? mintA.slice(0, 6),
      tokenB: metaB?.symbol ?? mintB.slice(0, 6),
      mintA,
      mintB,
      amountA,
      amountB,
      valueUsd,
      unclaimedFeesA,
      unclaimedFeesB,
      unclaimedFeesUsd,
      lowerPrice,
      upperPrice,
      inRange,
    };
  }

  /**
   * Estimate token amounts from liquidity and price range.
   * Uses the concentrated liquidity math:
   *   amountA = L * (1/sqrt(P_lower) - 1/sqrt(P_upper))  when price < lower
   *   amountB = L * (sqrt(P_upper) - sqrt(P_lower))       when price > upper
   *   both when price is in range
   */
  private estimateTokenAmounts(
    liquidity: bigint,
    currentSqrtPrice: bigint,
    tickLower: number,
    tickUpper: number,
    decimalsA: number,
    decimalsB: number,
  ): { amountA: number; amountB: number } {
    // Use whirlpools-core to get tick prices as sqrt prices
    // sqrtPrice is stored as Q64.64 fixed-point
    const Q64 = 2n ** 64n;

    // Convert tick indices to sqrt prices
    const sqrtPriceLower = this.tickToSqrtPrice(tickLower);
    const sqrtPriceUpper = this.tickToSqrtPrice(tickUpper);

    let rawA = 0n;
    let rawB = 0n;

    if (currentSqrtPrice < sqrtPriceLower) {
      // Price below range: all in token A
      rawA = (liquidity * Q64 * (sqrtPriceUpper - sqrtPriceLower)) /
        (sqrtPriceLower * sqrtPriceUpper);
    } else if (currentSqrtPrice >= sqrtPriceUpper) {
      // Price above range: all in token B
      rawB = (liquidity * (sqrtPriceUpper - sqrtPriceLower)) / Q64;
    } else {
      // In range
      rawA = (liquidity * Q64 * (sqrtPriceUpper - currentSqrtPrice)) /
        (currentSqrtPrice * sqrtPriceUpper);
      rawB = (liquidity * (currentSqrtPrice - sqrtPriceLower)) / Q64;
    }

    return {
      amountA: tokenAmountToUi(rawA, decimalsA),
      amountB: tokenAmountToUi(rawB, decimalsB),
    };
  }

  private tickToSqrtPrice(tickIndex: number): bigint {
    // sqrt_price = 2^64 * 1.0001^(tick/2)
    const price = Math.pow(1.0001, tickIndex / 2);
    return BigInt(Math.floor(price * Number(2n ** 64n)));
  }

  // ── LpProvider: getDepositQuote ───────────────────────────

  async getDepositQuote(walletName: string, params: LpDepositParams): Promise<LpDepositQuote> {
    await this.ensureConfig();

    const signer = await this.ctx.signer.getSigner(walletName);

    const poolData = await fetchWhirlpool(this.ctx.rpc, address(params.poolId));
    const pool = poolData.data;

    const mintA = String(pool.tokenMintA);
    const mintB = String(pool.tokenMintB);

    const [metaA, metaB] = await Promise.all([
      this.deps.registry.resolveToken(mintA),
      this.deps.registry.resolveToken(mintB),
    ]);

    if (metaA?.decimals == null || metaB?.decimals == null) {
      throw new Error(`Cannot resolve decimals for ${metaA?.decimals == null ? mintA : mintB}. Token not found in registry.`);
    }
    const decimalsA = metaA.decimals;
    const decimalsB = metaB.decimals;
    const currentPrice = sqrtPriceToPrice(pool.sqrtPrice, decimalsA, decimalsB);

    const { lowerPrice, upperPrice } = this.resolveRange(params, currentPrice);

    // Build the liquidity param from user-specified amount
    const depositParam = this.buildDepositParam(params, metaA, metaB);

    // Get quote from the SDK (funder required even for quote-only)
    let quote;
    if (params.positionId) {
      const result = await increaseLiquidityInstructions(
        this.ctx.rpc,
        address(params.positionId),
        depositParam,
        params.slippageBps ?? 100,
        signer,
      );
      quote = result.quote;
    } else {
      const result = await openPositionInstructions(
        this.ctx.rpc,
        address(params.poolId),
        depositParam,
        lowerPrice,
        upperPrice,
        params.slippageBps ?? 100,
        signer,
      );
      quote = result.quote;
    }

    const amountA = tokenAmountToUi(quote.tokenEstA, decimalsA);
    const amountB = tokenAmountToUi(quote.tokenEstB, decimalsB);

    const prices = await this.deps.price.getPrices([mintA, mintB]);
    const priceA = prices.get(mintA)?.priceUsd ?? 0;
    const priceB = prices.get(mintB)?.priceUsd ?? 0;

    return {
      poolId: params.poolId,
      protocol: 'orca',
      tokenA: metaA?.symbol ?? mintA.slice(0, 6),
      tokenB: metaB?.symbol ?? mintB.slice(0, 6),
      amountA,
      amountB,
      estimatedValueUsd: amountA * priceA + amountB * priceB,
      priceImpactPct: null,
      lowerPrice,
      upperPrice,
      currentPrice,
    };
  }

  // ── LpProvider: deposit ───────────────────────────────────

  async deposit(walletName: string, params: LpDepositParams): Promise<LpWriteResult> {
    await this.ensureConfig();

    const signer = await this.ctx.signer.getSigner(walletName);

    const poolData = await fetchWhirlpool(this.ctx.rpc, address(params.poolId));
    const pool = poolData.data;

    const mintA = String(pool.tokenMintA);
    const mintB = String(pool.tokenMintB);

    const [metaA, metaB] = await Promise.all([
      this.deps.registry.resolveToken(mintA),
      this.deps.registry.resolveToken(mintB),
    ]);

    if (metaA?.decimals == null || metaB?.decimals == null) {
      throw new Error(`Cannot resolve decimals for ${metaA?.decimals == null ? mintA : mintB}. Token not found in registry.`);
    }
    const decimalsA = metaA.decimals;
    const decimalsB = metaB.decimals;
    const currentPrice = sqrtPriceToPrice(pool.sqrtPrice, decimalsA, decimalsB);

    const depositParam = this.buildDepositParam(params, metaA, metaB);
    const slippageBps = params.slippageBps ?? 100;

    let instructions: Instruction[];
    let positionMint: string | undefined;

    if (params.positionId) {
      // Add liquidity to existing position
      this.ctx.logger.verbose(`Adding liquidity to existing Orca position ${params.positionId}`);
      const result = await increaseLiquidityInstructions(
        this.ctx.rpc,
        address(params.positionId),
        depositParam,
        slippageBps,
        signer,
      );
      instructions = result.instructions;
      positionMint = params.positionId;
    } else {
      // Open new position
      const { lowerPrice, upperPrice } = this.resolveRange(params, currentPrice);

      this.ctx.logger.verbose(
        `Opening new Orca position on ${metaA?.symbol ?? mintA}/${metaB?.symbol ?? mintB} ` +
        `range [${lowerPrice.toFixed(6)}, ${upperPrice.toFixed(6)}]`,
      );

      const result = await openPositionInstructions(
        this.ctx.rpc,
        address(params.poolId),
        depositParam,
        lowerPrice,
        upperPrice,
        slippageBps,
        signer,
      );
      instructions = result.instructions;
      positionMint = String(result.positionMint);
    }

    const prices = await this.deps.price.getPrices([mintA, mintB]);
    const priceA = prices.get(mintA)?.priceUsd;

    const sendResult = await this.deps.tx.buildAndSendTransaction(
      instructions as any[],
      signer,
      {
        txType: 'lp_deposit',
        walletName,
        fromMint: mintA,
        fromPriceUsd: priceA,
      },
    );

    return {
      signature: sendResult.signature,
      protocol: 'orca',
      explorerUrl: sendResult.explorerUrl,
      positionId: positionMint,
    };
  }

  // ── LpProvider: withdraw ──────────────────────────────────

  async withdraw(walletName: string, params: LpWithdrawParams): Promise<LpWriteResult> {
    await this.ensureConfig();

    const signer = await this.ctx.signer.getSigner(walletName);
    const slippageBps = params.slippageBps ?? 100;

    let instructions: Instruction[];

    if (params.percent >= 100 && params.close !== false) {
      // Full close
      this.ctx.logger.verbose(`Closing Orca position ${params.positionId}`);

      const result = await closePositionInstructions(
        this.ctx.rpc,
        address(params.positionId),
        slippageBps,
        signer,
      );
      instructions = result.instructions;
    } else {
      // Partial withdraw: need to get position liquidity and calculate percentage
      this.ctx.logger.verbose(`Withdrawing ${params.percent}% from Orca position ${params.positionId}`);

      // Fetch the position to get its liquidity (derive PDA from position mint)
      const [positionPda] = await getPositionAddress(address(params.positionId));
      const posAccount = await fetchPosition(this.ctx.rpc, positionPda);
      const totalLiquidity = posAccount.data.liquidity;

      const liquidityToRemove = (totalLiquidity * BigInt(Math.round(params.percent * 100))) / 10000n;

      const decreaseParam: DecreaseLiquidityQuoteParam = { liquidity: liquidityToRemove };

      const result = await decreaseLiquidityInstructions(
        this.ctx.rpc,
        address(params.positionId),
        decreaseParam,
        slippageBps,
        signer,
      );
      instructions = result.instructions;
    }

    const sendResult = await this.deps.tx.buildAndSendTransaction(
      instructions as any[],
      signer,
      {
        txType: 'lp_withdraw',
        walletName,
      },
    );

    return {
      signature: sendResult.signature,
      protocol: 'orca',
      explorerUrl: sendResult.explorerUrl,
      positionId: params.positionId,
    };
  }

  // ── LpProvider: claimFees ─────────────────────────────────

  async claimFees(walletName: string, positionId: string): Promise<LpWriteResult> {
    await this.ensureConfig();

    const signer = await this.ctx.signer.getSigner(walletName);

    this.ctx.logger.verbose(`Harvesting fees from Orca position ${positionId}`);

    const result = await harvestPositionInstructions(
      this.ctx.rpc,
      address(positionId),
      signer,
    );

    const sendResult = await this.deps.tx.buildAndSendTransaction(
      result.instructions as any[],
      signer,
      {
        txType: 'lp_claim',
        walletName,
      },
    );

    return {
      signature: sendResult.signature,
      protocol: 'orca',
      explorerUrl: sendResult.explorerUrl,
      positionId,
    };
  }

  // ── LpProvider: getConfigs ───────────────────────────────

  async getConfigs(): Promise<PoolConfig[]> {
    // Orca Whirlpools: tick spacing is the primary config parameter.
    // Fee rate is set per-pool at creation time, not predetermined by tick spacing.
    // Common pairings: ts=1 → 1-2bps, ts=64 → 30-100bps, ts=128 → 100-200bps.
    const spacingToTypicalFee: Record<number, number> = {
      1: 1, 2: 2, 4: 4, 8: 8, 16: 16, 32: 30, 64: 64, 128: 128, 256: 200,
    };

    return [1, 2, 4, 8, 16, 32, 64, 128, 256].map(ts => ({
      protocol: 'orca',
      poolType: 'clmm' as const,
      feeBps: spacingToTypicalFee[ts],
      tickSpacing: ts,
    }));
  }

  // ── LpProvider: createPool ────────────────────────────────

  async createPool(walletName: string, params: CreatePoolParams): Promise<LpWriteResult> {
    await this.ensureConfig();

    const signer = await this.ctx.signer.getSigner(walletName);
    const tickSpacing = params.tickSpacing ?? 64;

    const [metaA, metaB] = await Promise.all([
      this.resolveTokenStrict(params.mintA),
      this.resolveTokenStrict(params.mintB),
    ]);

    if (!params.initialPrice) {
      throw new Error('Initial price is required for creating an Orca CLMM pool');
    }

    // Orca requires canonical token ordering (sorted by mint pubkey bytes).
    // Auto-flip and invert price if needed.
    let tokenA = metaA;
    let tokenB = metaB;
    let initialPrice = params.initialPrice;
    if (metaA.mint > metaB.mint) {
      tokenA = metaB;
      tokenB = metaA;
      initialPrice = 1 / initialPrice;
    }

    this.ctx.logger.verbose(
      `Creating Orca CLMM pool ${tokenA.symbol}/${tokenB.symbol} ` +
      `tickSpacing=${tickSpacing} initialPrice=${initialPrice}`,
    );

    const result = await createConcentratedLiquidityPoolInstructions(
      this.ctx.rpc,
      address(tokenA.mint),
      address(tokenB.mint),
      tickSpacing,
      initialPrice,
      signer,
    );

    const sendResult = await this.deps.tx.buildAndSendTransaction(
      result.instructions as any[],
      signer,
      {
        txType: 'lp_create_pool',
        walletName,
      },
    );

    return {
      signature: sendResult.signature,
      protocol: 'orca',
      explorerUrl: sendResult.explorerUrl,
      positionId: String(result.poolAddress),
    };
  }

  // ── Shared helpers ────────────────────────────────────────

  private resolveRange(
    params: LpDepositParams,
    currentPrice: number,
  ): { lowerPrice: number; upperPrice: number } {
    if (params.lowerPrice != null && params.upperPrice != null) {
      return { lowerPrice: params.lowerPrice, upperPrice: params.upperPrice };
    }

    if (params.rangePct != null) {
      const pct = params.rangePct / 100;
      return {
        lowerPrice: currentPrice * (1 - pct),
        upperPrice: currentPrice * (1 + pct),
      };
    }

    throw new Error(
      'CLMM pools require a price range. ' +
      'Use --range <pct> for symmetric range (e.g. --range 10 for +/- 10%) ' +
      'or --lower-price / --upper-price for custom bounds.',
    );
  }

  private buildDepositParam(
    params: LpDepositParams,
    metaA?: TokenMetadata,
    metaB?: TokenMetadata,
  ): IncreaseLiquidityQuoteParam {
    if (metaA?.decimals == null || metaB?.decimals == null) {
      throw new Error('Cannot build deposit: token metadata with decimals required');
    }
    const decimalsA = metaA.decimals;
    const decimalsB = metaB.decimals;

    // If amountA or amountB explicitly provided
    if (params.amountA != null && params.amountA > 0) {
      return { tokenA: uiToTokenAmount(params.amountA, decimalsA) };
    }
    if (params.amountB != null && params.amountB > 0) {
      return { tokenB: uiToTokenAmount(params.amountB, decimalsB) };
    }

    // If generic amount + token provided, figure out which side
    if (params.amount != null && params.amount > 0) {
      const tokenStr = (params.token ?? '').toLowerCase();
      const symbolA = (metaA?.symbol ?? '').toLowerCase();
      const symbolB = (metaB?.symbol ?? '').toLowerCase();
      const mintA = metaA?.mint ?? '';
      const mintB = metaB?.mint ?? '';

      if (tokenStr === symbolB || tokenStr === mintB) {
        return { tokenB: uiToTokenAmount(params.amount, decimalsB) };
      }
      // Default to token A
      return { tokenA: uiToTokenAmount(params.amount, decimalsA) };
    }

    throw new Error(
      'Deposit amount required. Provide --amount-a, --amount-b, or --amount with --token.',
    );
  }
}
