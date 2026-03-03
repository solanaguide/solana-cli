import {
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { withRetry, isRetryableHttpError } from '../utils/retry.js';
import { getJupiterBaseUrl, getJupiterHeaders } from '../utils/jupiter-api.js';
import { uiToTokenAmount, isValidAddress } from '../utils/solana.js';
import type { SolContext } from '../types.js';
import type { TokenRegistryService } from './token-registry-service.js';
import type { PriceService } from './price-service.js';

// ── Types ───────────────────────────────────────────────────

export interface DcaOrder {
  orderKey: string;
  inputMint: string;
  outputMint: string;
  inputSymbol?: string;
  outputSymbol?: string;
  inAmountPerCycle: string;
  cycleFrequency: string;
  inDeposited: string;
  inUsed: string;
  outReceived: string;
  createdAt: string;
  trades: any[];
  status: string;
}

export interface DcaCreateResult {
  signature: string;
  orderKey?: string;
  inputSymbol: string;
  outputSymbol: string;
  totalAmount: number;
  amountPerOrder: number;
  count: number;
  interval: string;
}

export interface LimitOrder {
  orderKey: string;
  inputMint: string;
  outputMint: string;
  inputSymbol?: string;
  outputSymbol?: string;
  makingAmount: string;
  takingAmount: string;
  remainingMakingAmount: string;
  remainingTakingAmount: string;
  slippageBps: string;
  expiredAt: string | null;
  createdAt: string;
  status: string;
  trades: any[];
}

export interface LimitCreateResult {
  signature: string;
  orderKey?: string;
  inputSymbol: string;
  outputSymbol: string;
  inputAmount: number;
  targetPrice: number;
  outputAmount: number;
}

export interface OpenOrderPosition {
  type: 'dca' | 'limit';
  orderKey: string;
  inputMint: string;
  outputMint: string;
  inputSymbol?: string;
  outputSymbol?: string;
  remainingInputAmount: number;
  inputDecimals: number;
  valueUsd: number | null;
  status: string;
  extra?: Record<string, unknown>;
}

export interface OrderService {
  createDca(totalAmount: number, inputSymbol: string, outputSymbol: string, walletName: string, opts: { interval: string; count: number }): Promise<DcaCreateResult>;
  listDca(walletAddress: string, opts?: { status?: string }): Promise<DcaOrder[]>;
  cancelDca(orderKey: string, walletName: string): Promise<string>;
  createLimit(inputAmount: number, inputSymbol: string, outputSymbol: string, walletName: string, opts: { targetPrice: number; slippageBps?: number; expiredAt?: number }): Promise<LimitCreateResult>;
  listLimit(walletAddress: string, opts?: { status?: string }): Promise<LimitOrder[]>;
  cancelLimit(orderKey: string, walletName: string): Promise<string>;
  getOpenOrders(walletAddress: string): Promise<OpenOrderPosition[]>;
}

// ── Helpers ─────────────────────────────────────────────────

const INTERVAL_SECONDS: Record<string, number> = {
  minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000,
};

export function parseInterval(interval: string): number {
  const seconds = INTERVAL_SECONDS[interval.toLowerCase()];
  if (!seconds) throw new Error(`Invalid interval: ${interval}. Use: ${Object.keys(INTERVAL_SECONDS).join(', ')}`);
  return seconds;
}

function cleanErrorBody(body: string): string {
  if (body.includes('<html') || body.includes('<!DOCTYPE')) {
    const titleMatch = body.match(/<title>(.*?)<\/title>/i);
    return titleMatch ? titleMatch[1] : 'Server returned HTML error page';
  }
  try {
    const json = JSON.parse(body);
    return json.error || json.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// ── Factory ─────────────────────────────────────────────────

export function createOrderService(
  ctx: SolContext,
  deps: { registry: TokenRegistryService; price: PriceService },
): OrderService {
  const { logger, rpc, signer, txLogger } = ctx;

  function getTriggerUrl(): string {
    return `${getJupiterBaseUrl(ctx)}/trigger/v1`;
  }

  function getRecurringUrl(): string {
    return `${getJupiterBaseUrl(ctx)}/recurring/v1`;
  }

  async function signAndExecute(txBase64: string, requestId: string, executeUrl: string, walletName: string): Promise<string> {
    const signerObj = await signer.getSigner(walletName);

    const txBytes = new Uint8Array(Buffer.from(txBase64, 'base64'));
    const rawTx = getTransactionDecoder().decode(txBytes);
    const compiledMsg = getCompiledTransactionMessageDecoder().decode(rawTx.messageBytes);
    const msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

    const msgWithSigner = Object.assign({}, msg, { feePayer: signerObj });

    logger.verbose('Signing order transaction...');
    const signedTx = await signTransactionMessageWithSigners(msgWithSigner);
    const encodedTx = getBase64EncodedWireTransaction(signedTx);

    const res = await withRetry(
      () => fetch(executeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJupiterHeaders(ctx) },
        body: JSON.stringify({ requestId, signedTransaction: encodedTx }),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Execute failed (${res.status}): ${cleanErrorBody(body)}`);
    }

    const data = await res.json() as any;
    if (data.status === 'Failed') {
      throw new Error(`Order execution failed: ${data.error || 'unknown error'}`);
    }

    return data.signature;
  }

  async function createDca(totalAmount: number, inputSymbol: string, outputSymbol: string, walletName: string, opts: { interval: string; count: number }): Promise<DcaCreateResult> {
    const inputToken = await deps.registry.resolveToken(inputSymbol);
    if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);
    const outputToken = await deps.registry.resolveToken(outputSymbol);
    if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

    if (opts.count < 2) throw new Error('DCA requires at least 2 orders');

    const intervalSeconds = parseInterval(opts.interval);
    const rawTotalAmount = uiToTokenAmount(totalAmount, inputToken.decimals);
    const amountPerOrder = totalAmount / opts.count;

    let inputPriceUsd: number | undefined;
    try {
      const prices = await deps.price.getPrices([inputToken.mint]);
      inputPriceUsd = prices.get(inputToken.mint)?.priceUsd;
    } catch { /* non-critical */ }

    if (inputPriceUsd) {
      const totalUsd = totalAmount * inputPriceUsd;
      const perOrderUsd = amountPerOrder * inputPriceUsd;
      if (totalUsd < 100) throw new Error(`Total value must be >= $100 (currently ~$${totalUsd.toFixed(2)})`);
      if (perOrderUsd < 50) throw new Error(`Each order must be >= $50 (currently ~$${perOrderUsd.toFixed(2)}). Reduce --count or increase amount.`);
    }

    const signerObj = await signer.getSigner(walletName);

    logger.verbose(`Creating DCA: ${totalAmount} ${inputToken.symbol} → ${outputToken.symbol}, ${opts.count} orders every ${opts.interval}`);

    const res = await withRetry(
      () => fetch(`${getRecurringUrl()}/createOrder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJupiterHeaders(ctx) },
        body: JSON.stringify({
          user: signerObj.address,
          inputMint: inputToken.mint,
          outputMint: outputToken.mint,
          params: {
            time: {
              inAmount: Number(rawTotalAmount),
              numberOfOrders: opts.count,
              interval: intervalSeconds,
              startAt: null, minPrice: null, maxPrice: null,
            },
          },
        }),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DCA create failed (${res.status}): ${cleanErrorBody(body)}`);
    }

    const data = await res.json() as any;
    const signature = await signAndExecute(data.transaction, data.requestId, `${getRecurringUrl()}/execute`, walletName);

    txLogger.log({
      signature,
      type: 'dca_create',
      walletName,
      fromMint: inputToken.mint,
      toMint: outputToken.mint,
      fromAmount: String(rawTotalAmount),
      fromPriceUsd: inputPriceUsd,
      status: 'confirmed',
    });

    return { signature, orderKey: data.order, inputSymbol: inputToken.symbol, outputSymbol: outputToken.symbol, totalAmount, amountPerOrder, count: opts.count, interval: opts.interval };
  }

  async function listDca(walletAddress: string, opts: { status?: string } = {}): Promise<DcaOrder[]> {
    const orderStatus = opts.status ?? 'active';
    const url = `${getRecurringUrl()}/getRecurringOrders?user=${walletAddress}&orderStatus=${orderStatus}&recurringType=time&page=1&includeFailedTx=false`;

    logger.verbose(`Fetching DCA orders: ${url}`);

    const res = await withRetry(
      () => fetch(url, { headers: getJupiterHeaders(ctx) }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DCA list failed (${res.status}): ${cleanErrorBody(body)}`);
    }

    const data = await res.json() as any;
    const orders = data.time || data.all || [];

    return orders.map((o: any) => ({
      orderKey: o.orderKey, inputMint: o.inputMint, outputMint: o.outputMint,
      inAmountPerCycle: o.inAmountPerCycle || o.rawInAmountPerCycle,
      cycleFrequency: o.cycleFrequency,
      inDeposited: o.inDeposited || o.rawInDeposited,
      inUsed: o.inUsed || o.rawInUsed,
      outReceived: o.outReceived || o.rawOutReceived,
      createdAt: o.createdAt,
      trades: o.trades || [],
      status: o.userClosed ? 'cancelled' : (orderStatus === 'active' ? 'active' : 'completed'),
    }));
  }

  async function cancelDca(orderKey: string, walletName: string): Promise<string> {
    if (!isValidAddress(orderKey)) throw new Error(`Invalid order key: ${orderKey}`);
    const signerObj = await signer.getSigner(walletName);

    const res = await withRetry(
      () => fetch(`${getRecurringUrl()}/cancelOrder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJupiterHeaders(ctx) },
        body: JSON.stringify({ user: signerObj.address, order: orderKey, recurringType: 'time' }),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DCA cancel failed (${res.status}): ${cleanErrorBody(body)}`);
    }

    const data = await res.json() as any;
    const signature = await signAndExecute(data.transaction, data.requestId, `${getRecurringUrl()}/execute`, walletName);

    txLogger.log({ signature, type: 'dca_cancel', walletName, status: 'confirmed' });
    return signature;
  }

  async function createLimit(inputAmount: number, inputSymbol: string, outputSymbol: string, walletName: string, opts: { targetPrice: number; slippageBps?: number; expiredAt?: number }): Promise<LimitCreateResult> {
    const inputToken = await deps.registry.resolveToken(inputSymbol);
    if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);
    const outputToken = await deps.registry.resolveToken(outputSymbol);
    if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

    let inputPriceUsd: number | undefined;
    try {
      const prices = await deps.price.getPrices([inputToken.mint]);
      inputPriceUsd = prices.get(inputToken.mint)?.priceUsd;
    } catch { /* non-critical */ }

    if (!inputPriceUsd) throw new Error(`Cannot determine price for ${inputSymbol}. Price is needed to calculate limit order.`);

    const inputValueUsd = inputAmount * inputPriceUsd;
    const outputUiAmount = inputValueUsd / opts.targetPrice;
    const rawInputAmount = uiToTokenAmount(inputAmount, inputToken.decimals);
    const rawOutputAmount = uiToTokenAmount(outputUiAmount, outputToken.decimals);

    logger.verbose(`Creating limit order: ${inputAmount} ${inputToken.symbol} → ${outputUiAmount.toFixed(6)} ${outputToken.symbol} at $${opts.targetPrice}`);

    const signerObj = await signer.getSigner(walletName);

    const body: any = {
      inputMint: inputToken.mint, outputMint: outputToken.mint,
      maker: signerObj.address, payer: signerObj.address,
      params: { makingAmount: String(rawInputAmount), takingAmount: String(rawOutputAmount) },
      computeUnitPrice: 'auto', wrapAndUnwrapSol: true,
    };
    if (opts.slippageBps != null) body.params.slippageBps = String(opts.slippageBps);
    if (opts.expiredAt != null) body.params.expiredAt = String(opts.expiredAt);

    const res = await withRetry(
      () => fetch(`${getTriggerUrl()}/createOrder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJupiterHeaders(ctx) },
        body: JSON.stringify(body),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const respBody = await res.text();
      throw new Error(`Limit order create failed (${res.status}): ${cleanErrorBody(respBody)}`);
    }

    const data = await res.json() as any;
    const signature = await signAndExecute(data.transaction, data.requestId, `${getTriggerUrl()}/execute`, walletName);

    txLogger.log({
      signature,
      type: 'limit_create',
      walletName,
      fromMint: inputToken.mint,
      toMint: outputToken.mint,
      fromAmount: String(rawInputAmount),
      toAmount: String(rawOutputAmount),
      fromPriceUsd: inputPriceUsd,
      status: 'confirmed',
    });

    return { signature, orderKey: data.order, inputSymbol: inputToken.symbol, outputSymbol: outputToken.symbol, inputAmount, targetPrice: opts.targetPrice, outputAmount: outputUiAmount };
  }

  async function listLimit(walletAddress: string, opts: { status?: string } = {}): Promise<LimitOrder[]> {
    const orderStatus = opts.status ?? 'active';
    const url = `${getTriggerUrl()}/getTriggerOrders?user=${walletAddress}&orderStatus=${orderStatus}&page=1`;

    logger.verbose(`Fetching limit orders: ${url}`);

    const res = await withRetry(
      () => fetch(url, { headers: getJupiterHeaders(ctx) }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Limit order list failed (${res.status}): ${cleanErrorBody(body)}`);
    }

    const data = await res.json() as any;
    const orders = data.orders || [];

    return orders.map((o: any) => ({
      orderKey: o.orderKey, inputMint: o.inputMint, outputMint: o.outputMint,
      makingAmount: o.makingAmount || o.rawMakingAmount,
      takingAmount: o.takingAmount || o.rawTakingAmount,
      remainingMakingAmount: o.remainingMakingAmount || o.rawRemainingMakingAmount,
      remainingTakingAmount: o.remainingTakingAmount || o.rawRemainingTakingAmount,
      slippageBps: o.slippageBps || '0',
      expiredAt: o.expiredAt, createdAt: o.createdAt,
      status: o.status || orderStatus,
      trades: o.trades || [],
    }));
  }

  async function cancelLimit(orderKey: string, walletName: string): Promise<string> {
    if (!isValidAddress(orderKey)) throw new Error(`Invalid order key: ${orderKey}`);
    const signerObj = await signer.getSigner(walletName);

    const res = await withRetry(
      () => fetch(`${getTriggerUrl()}/cancelOrder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJupiterHeaders(ctx) },
        body: JSON.stringify({ maker: signerObj.address, order: orderKey, computeUnitPrice: 'auto' }),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Limit order cancel failed (${res.status}): ${cleanErrorBody(body)}`);
    }

    const data = await res.json() as any;
    const signature = await signAndExecute(data.transaction, data.requestId, `${getTriggerUrl()}/execute`, walletName);

    txLogger.log({ signature, type: 'limit_cancel', walletName, status: 'confirmed' });
    return signature;
  }

  async function getOpenOrders(walletAddress: string): Promise<OpenOrderPosition[]> {
    const positions: OpenOrderPosition[] = [];

    const [dcaOrders, limitOrders] = await Promise.all([
      listDca(walletAddress, { status: 'active' }).catch((err) => { logger.verbose(`Could not fetch DCA orders: ${err}`); return [] as DcaOrder[]; }),
      listLimit(walletAddress, { status: 'active' }).catch((err) => { logger.verbose(`Could not fetch limit orders: ${err}`); return [] as LimitOrder[]; }),
    ]);

    const mints = new Set<string>();
    for (const o of dcaOrders) mints.add(o.inputMint);
    for (const o of limitOrders) mints.add(o.inputMint);

    let prices = new Map<string, { priceUsd: number }>();
    if (mints.size > 0) {
      try { prices = await deps.price.getPrices([...mints]); } catch { /* non-critical */ }
    }

    const tokenCache = new Map<string, { symbol: string; decimals: number }>();
    async function getTokenInfo(mint: string) {
      if (tokenCache.has(mint)) return tokenCache.get(mint)!;
      try {
        const t = await deps.registry.resolveToken(mint);
        if (t) { tokenCache.set(mint, { symbol: t.symbol, decimals: t.decimals }); return { symbol: t.symbol, decimals: t.decimals }; }
      } catch { /* non-critical */ }
      return undefined;
    }

    for (const o of dcaOrders) {
      const inputInfo = await getTokenInfo(o.inputMint);
      const outputInfo = await getTokenInfo(o.outputMint);
      const deposited = Number(o.inDeposited || '0');
      const used = Number(o.inUsed || '0');
      const remainingUi = Math.max(0, deposited - used);
      const price = prices.get(o.inputMint);

      positions.push({
        type: 'dca', orderKey: o.orderKey, inputMint: o.inputMint, outputMint: o.outputMint,
        inputSymbol: inputInfo?.symbol || o.inputSymbol, outputSymbol: outputInfo?.symbol || o.outputSymbol,
        remainingInputAmount: remainingUi, inputDecimals: inputInfo?.decimals ?? 6,
        valueUsd: price ? remainingUi * price.priceUsd : null, status: o.status,
        extra: { interval: o.cycleFrequency, deposited, used, received: o.outReceived, fillPct: deposited > 0 ? (used / deposited) * 100 : 0 },
      });
    }

    for (const o of limitOrders) {
      const inputInfo = await getTokenInfo(o.inputMint);
      const outputInfo = await getTokenInfo(o.outputMint);
      const remainingUi = Number(o.remainingMakingAmount || o.makingAmount || '0');
      const price = prices.get(o.inputMint);

      positions.push({
        type: 'limit', orderKey: o.orderKey, inputMint: o.inputMint, outputMint: o.outputMint,
        inputSymbol: inputInfo?.symbol || o.inputSymbol, outputSymbol: outputInfo?.symbol || o.outputSymbol,
        remainingInputAmount: remainingUi, inputDecimals: inputInfo?.decimals ?? 6,
        valueUsd: price ? remainingUi * price.priceUsd : null, status: o.status,
        extra: {
          makingAmount: Number(o.makingAmount || '0'), takingAmount: o.takingAmount, createdAt: o.createdAt,
          fillPct: (() => { const total = Number(o.makingAmount || '0'); const remaining = Number(o.remainingMakingAmount || o.makingAmount || '0'); return total > 0 ? ((total - remaining) / total) * 100 : 0; })(),
        },
      });
    }

    return positions;
  }

  return { createDca, listDca, cancelDca, createLimit, listLimit, cancelLimit, getOpenOrders };
}
