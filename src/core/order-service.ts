import { verbose } from '../output/formatter.js';
import { getJupiterBaseUrl, getJupiterHeaders } from '../utils/jupiter-api.js';
import { withRetry, isRetryableHttpError } from '../utils/retry.js';
import { resolveToken } from './token-registry.js';
import { loadSigner } from './wallet-manager.js';
import { uiToTokenAmount, isValidAddress, SOL_MINT } from '../utils/solana.js';
import { getPrices } from './price-service.js';
import {
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getRpc } from './rpc.js';
import { logTransaction } from './transaction.js';

// ── Helpers ────────────────────────────────────────────────

function cleanErrorBody(body: string): string {
  // Strip HTML — extract title or just truncate
  if (body.includes('<html') || body.includes('<!DOCTYPE')) {
    const titleMatch = body.match(/<title>(.*?)<\/title>/i);
    return titleMatch ? titleMatch[1] : 'Server returned HTML error page';
  }
  // Try to parse JSON error
  try {
    const json = JSON.parse(body);
    return json.error || json.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

function getTriggerUrl(): string {
  return `${getJupiterBaseUrl()}/trigger/v1`;
}

function getRecurringUrl(): string {
  return `${getJupiterBaseUrl()}/recurring/v1`;
}

async function signAndExecute(
  txBase64: string,
  requestId: string,
  executeUrl: string,
  walletName: string,
): Promise<string> {
  const signer = await loadSigner(walletName);
  const rpc = getRpc();

  // Decode, decompile, inject signer, sign
  const txBytes = new Uint8Array(Buffer.from(txBase64, 'base64'));
  const rawTx = getTransactionDecoder().decode(txBytes);
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(rawTx.messageBytes);
  const msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

  // Replace fee payer address with actual signer so signTransactionMessageWithSigners can sign
  const msgWithSigner = Object.assign({}, msg, { feePayer: signer });

  verbose('Signing order transaction...');
  const signedTx = await signTransactionMessageWithSigners(msgWithSigner);
  const encodedTx = getBase64EncodedWireTransaction(signedTx);

  // Execute via Jupiter
  const res = await withRetry(
    () => fetch(executeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getJupiterHeaders() },
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

// ── Interval mapping ───────────────────────────────────────

const INTERVAL_SECONDS: Record<string, number> = {
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
};

export function parseInterval(interval: string): number {
  const seconds = INTERVAL_SECONDS[interval.toLowerCase()];
  if (!seconds) {
    throw new Error(`Invalid interval: ${interval}. Use: ${Object.keys(INTERVAL_SECONDS).join(', ')}`);
  }
  return seconds;
}

// ── DCA (Recurring) ────────────────────────────────────────

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

export async function createDcaOrder(
  totalAmount: number,
  inputSymbol: string,
  outputSymbol: string,
  walletName: string,
  opts: { interval: string; count: number }
): Promise<DcaCreateResult> {
  const inputToken = await resolveToken(inputSymbol);
  if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

  const outputToken = await resolveToken(outputSymbol);
  if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

  if (opts.count < 2) throw new Error('DCA requires at least 2 orders');

  const intervalSeconds = parseInterval(opts.interval);
  const rawTotalAmount = uiToTokenAmount(totalAmount, inputToken.decimals);
  const amountPerOrder = totalAmount / opts.count;

  // Validate minimums
  let inputPriceUsd: number | undefined;
  try {
    const prices = await getPrices([inputToken.mint]);
    inputPriceUsd = prices.get(inputToken.mint)?.priceUsd;
  } catch { /* non-critical */ }

  if (inputPriceUsd) {
    const totalUsd = totalAmount * inputPriceUsd;
    const perOrderUsd = amountPerOrder * inputPriceUsd;
    if (totalUsd < 100) throw new Error(`Total value must be >= $100 (currently ~$${totalUsd.toFixed(2)})`);
    if (perOrderUsd < 50) throw new Error(`Each order must be >= $50 (currently ~$${perOrderUsd.toFixed(2)}). Reduce --count or increase amount.`);
  }

  const signer = await loadSigner(walletName);

  verbose(`Creating DCA: ${totalAmount} ${inputToken.symbol} → ${outputToken.symbol}, ${opts.count} orders every ${opts.interval}`);

  const res = await withRetry(
    () => fetch(`${getRecurringUrl()}/createOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getJupiterHeaders() },
      body: JSON.stringify({
        user: signer.address,
        inputMint: inputToken.mint,
        outputMint: outputToken.mint,
        params: {
          time: {
            inAmount: Number(rawTotalAmount),
            numberOfOrders: opts.count,
            interval: intervalSeconds,
            startAt: null,
            minPrice: null,
            maxPrice: null,
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
  const signature = await signAndExecute(
    data.transaction,
    data.requestId,
    `${getRecurringUrl()}/execute`,
    walletName,
  );

  logTransaction({
    signature,
    type: 'dca_create',
    walletName,
    fromMint: inputToken.mint,
    toMint: outputToken.mint,
    fromAmount: String(rawTotalAmount),
    status: 'confirmed',
  });

  return {
    signature,
    orderKey: data.order,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    totalAmount,
    amountPerOrder,
    count: opts.count,
    interval: opts.interval,
  };
}

export async function listDcaOrders(
  walletAddress: string,
  opts: { status?: string } = {}
): Promise<DcaOrder[]> {
  const orderStatus = opts.status ?? 'active';
  const url = `${getRecurringUrl()}/getRecurringOrders?user=${walletAddress}&orderStatus=${orderStatus}&recurringType=time&page=1&includeFailedTx=false`;

  verbose(`Fetching DCA orders: ${url}`);

  const res = await withRetry(
    () => fetch(url, { headers: getJupiterHeaders() }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DCA list failed (${res.status}): ${cleanErrorBody(body)}`);
  }

  const data = await res.json() as any;
  const orders = data.time || data.all || [];

  return orders.map((o: any) => ({
    orderKey: o.orderKey,
    inputMint: o.inputMint,
    outputMint: o.outputMint,
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

export async function cancelDcaOrder(
  orderKey: string,
  walletName: string,
): Promise<string> {
  if (!isValidAddress(orderKey)) throw new Error(`Invalid order key: ${orderKey}`);
  const signer = await loadSigner(walletName);

  const res = await withRetry(
    () => fetch(`${getRecurringUrl()}/cancelOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getJupiterHeaders() },
      body: JSON.stringify({
        user: signer.address,
        order: orderKey,
        recurringType: 'time',
      }),
    }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DCA cancel failed (${res.status}): ${cleanErrorBody(body)}`);
  }

  const data = await res.json() as any;
  const signature = await signAndExecute(
    data.transaction,
    data.requestId,
    `${getRecurringUrl()}/execute`,
    walletName,
  );

  logTransaction({
    signature,
    type: 'dca_cancel',
    walletName,
    status: 'confirmed',
  });

  return signature;
}

// ── Limit Orders (Trigger) ─────────────────────────────────

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

export async function createLimitOrder(
  inputAmount: number,
  inputSymbol: string,
  outputSymbol: string,
  walletName: string,
  opts: { targetPrice: number; slippageBps?: number; expiredAt?: number }
): Promise<LimitCreateResult> {
  const inputToken = await resolveToken(inputSymbol);
  if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

  const outputToken = await resolveToken(outputSymbol);
  if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

  // Calculate output amount from target price
  // targetPrice is the USD price of the output token at which we want to buy
  // outputAmount = (inputAmount * inputPriceUsd) / targetPriceUsd
  let inputPriceUsd: number | undefined;
  try {
    const prices = await getPrices([inputToken.mint]);
    inputPriceUsd = prices.get(inputToken.mint)?.priceUsd;
  } catch { /* non-critical */ }

  if (!inputPriceUsd) throw new Error(`Cannot determine price for ${inputSymbol}. Price is needed to calculate limit order.`);

  const inputValueUsd = inputAmount * inputPriceUsd;
  const outputUiAmount = inputValueUsd / opts.targetPrice;

  const rawInputAmount = uiToTokenAmount(inputAmount, inputToken.decimals);
  const rawOutputAmount = uiToTokenAmount(outputUiAmount, outputToken.decimals);

  verbose(`Creating limit order: ${inputAmount} ${inputToken.symbol} → ${outputUiAmount.toFixed(6)} ${outputToken.symbol} at $${opts.targetPrice}`);

  const signer = await loadSigner(walletName);

  const body: any = {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    maker: signer.address,
    payer: signer.address,
    params: {
      makingAmount: String(rawInputAmount),
      takingAmount: String(rawOutputAmount),
    },
    computeUnitPrice: 'auto',
    wrapAndUnwrapSol: true,
  };

  if (opts.slippageBps != null) {
    body.params.slippageBps = String(opts.slippageBps);
  }
  if (opts.expiredAt != null) {
    body.params.expiredAt = String(opts.expiredAt);
  }

  const res = await withRetry(
    () => fetch(`${getTriggerUrl()}/createOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getJupiterHeaders() },
      body: JSON.stringify(body),
    }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`Limit order create failed (${res.status}): ${cleanErrorBody(respBody)}`);
  }

  const data = await res.json() as any;
  const signature = await signAndExecute(
    data.transaction,
    data.requestId,
    `${getTriggerUrl()}/execute`,
    walletName,
  );

  logTransaction({
    signature,
    type: 'limit_create',
    walletName,
    fromMint: inputToken.mint,
    toMint: outputToken.mint,
    fromAmount: String(rawInputAmount),
    toAmount: String(rawOutputAmount),
    status: 'confirmed',
  });

  return {
    signature,
    orderKey: data.order,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    inputAmount,
    targetPrice: opts.targetPrice,
    outputAmount: outputUiAmount,
  };
}

export async function listLimitOrders(
  walletAddress: string,
  opts: { status?: string } = {}
): Promise<LimitOrder[]> {
  const orderStatus = opts.status ?? 'active';
  const url = `${getTriggerUrl()}/getTriggerOrders?user=${walletAddress}&orderStatus=${orderStatus}&page=1`;

  verbose(`Fetching limit orders: ${url}`);

  const res = await withRetry(
    () => fetch(url, { headers: getJupiterHeaders() }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Limit order list failed (${res.status}): ${cleanErrorBody(body)}`);
  }

  const data = await res.json() as any;
  const orders = data.orders || [];

  return orders.map((o: any) => ({
    orderKey: o.orderKey,
    inputMint: o.inputMint,
    outputMint: o.outputMint,
    makingAmount: o.makingAmount || o.rawMakingAmount,
    takingAmount: o.takingAmount || o.rawTakingAmount,
    remainingMakingAmount: o.remainingMakingAmount || o.rawRemainingMakingAmount,
    remainingTakingAmount: o.remainingTakingAmount || o.rawRemainingTakingAmount,
    slippageBps: o.slippageBps || '0',
    expiredAt: o.expiredAt,
    createdAt: o.createdAt,
    status: o.status || orderStatus,
    trades: o.trades || [],
  }));
}

export async function cancelLimitOrder(
  orderKey: string,
  walletName: string,
): Promise<string> {
  if (!isValidAddress(orderKey)) throw new Error(`Invalid order key: ${orderKey}`);
  const signer = await loadSigner(walletName);

  const res = await withRetry(
    () => fetch(`${getTriggerUrl()}/cancelOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getJupiterHeaders() },
      body: JSON.stringify({
        maker: signer.address,
        order: orderKey,
        computeUnitPrice: 'auto',
      }),
    }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Limit order cancel failed (${res.status}): ${cleanErrorBody(body)}`);
  }

  const data = await res.json() as any;
  const signature = await signAndExecute(
    data.transaction,
    data.requestId,
    `${getTriggerUrl()}/execute`,
    walletName,
  );

  logTransaction({
    signature,
    type: 'limit_cancel',
    walletName,
    status: 'confirmed',
  });

  return signature;
}
