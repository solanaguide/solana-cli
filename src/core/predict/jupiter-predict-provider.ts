import { verbose } from '../../output/formatter.js';
import { loadSigner } from '../wallet-manager.js';
import {
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import { sendEncodedTransaction } from '../transaction.js';
import { RateLimiter } from '../../utils/retry.js';
import type {
  PredictProvider,
  PredictionEvent,
  PredictionMarket,
  PredictionOrderbook,
  PredictionPosition,
  PredictionHistoryEntry,
  PredictionOrderResult,
  PredictionCloseResult,
  PredictionClaimResult,
} from './predict-provider.js';

const BASE_URL = 'https://prediction-market-api.jup.ag/api/v1';
const MICRODOLLAR = 1_000_000;
const rateLimiter = new RateLimiter(20, 60_000);

// ── Helpers ──────────────────────────────────────────────

async function jupFetch<T>(path: string, init?: RequestInit): Promise<T> {
  await rateLimiter.acquire();
  const url = `${BASE_URL}${path}`;
  verbose(`Jupiter Predict: ${init?.method ?? 'GET'} ${url}`);

  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jupiter Predict API ${res.status}: ${body || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

function microToUsd(micro: string | number): number {
  return Number(micro) / MICRODOLLAR;
}

function usdToMicro(usd: number): number {
  return Math.round(usd * MICRODOLLAR);
}

// ── Response types (raw API shapes) ─────────────────────

interface JupEvent {
  eventId: string;
  // Flat fields (from search/single-event endpoints)
  id?: string;
  title?: string;
  // Nested metadata (from list endpoint)
  metadata?: {
    title?: string;
    imageUrl?: string;
  };
  category: string;
  subcategory?: string;
  imageUrl?: string;
  isActive?: boolean;
  isLive?: boolean;
  status?: string;
  volumeUsd?: string | number;
  beginAt?: number;
  endAt?: number;
  createdAt?: number;
  markets?: JupMarket[];
}

interface JupMarketPricing {
  buyYesPriceUsd?: number;
  sellYesPriceUsd?: number;
  buyNoPriceUsd?: number;
  sellNoPriceUsd?: number;
  volume?: number;
}

interface JupMarket {
  marketId: string;
  // Flat fields (from single-market endpoints)
  id?: string;
  eventId?: string;
  title?: string;
  yesPriceUsd?: string | number;
  noPriceUsd?: string | number;
  volumeUsd?: string | number;
  // Nested fields (from list endpoint)
  metadata?: {
    title?: string;
    status?: string;
  };
  pricing?: JupMarketPricing;
  status?: string;
  result?: string | null;
  resolution?: string;
  settlementMint?: string;
}

interface JupPosition {
  pubkey: string;
  marketId: string;
  eventId: string;
  isYes: boolean;
  contracts: string;
  totalCostUsd: string;
  valueUsd?: string | null;
  avgPriceUsd: string;
  markPriceUsd?: string | null;
  pnlUsd?: string | null;
  pnlUsdPercent?: number | null;
  feesPaidUsd?: string;
  claimable?: boolean;
  payoutUsd?: string;
  openedAt?: number;
  eventMetadata?: { title?: string; category?: string };
  marketMetadata?: { title?: string };
}

interface JupHistoryEntry {
  id: string;
  eventType: string;
  marketId?: string;
  isYes?: boolean;
  contracts?: number;
  avgFillPriceUsd?: string;
  feeUsd?: string;
  timestamp?: number;
  signature?: string;
  eventMetadata?: { title?: string };
  marketMetadata?: { title?: string };
}

// ── Mappers ──────────────────────────────────────────────

function mapEvent(e: JupEvent): PredictionEvent {
  const id = e.eventId || e.id || '';
  const title = e.title || e.metadata?.title || '';
  const imageUrl = e.imageUrl || e.metadata?.imageUrl;
  const status = e.isActive === false ? 'closed' : mapStatus(e.status);

  return {
    id,
    provider: 'jupiter',
    title,
    category: e.category || 'unknown',
    subcategory: e.subcategory,
    imageUrl,
    status,
    markets: (e.markets ?? []).map(m => mapMarket(m, id)),
    volume: e.volumeUsd ? microToUsd(e.volumeUsd) : 0,
    beginAt: e.beginAt ? new Date(e.beginAt * 1000).toISOString() : undefined,
    endAt: e.endAt ? new Date(e.endAt * 1000).toISOString() : undefined,
    createdAt: e.createdAt ? new Date(e.createdAt * 1000).toISOString() : undefined,
  };
}

function mapMarket(m: JupMarket, parentEventId?: string): PredictionMarket {
  const id = m.marketId || m.id || '';
  const eventId = m.eventId || parentEventId || '';
  const title = m.title || m.metadata?.title || '';
  const status = mapStatus(m.status || m.metadata?.status);

  // Prices can come from pricing object (list) or flat fields (single)
  let yesPrice = 0;
  let noPrice = 0;
  let volume = 0;

  if (m.pricing) {
    yesPrice = m.pricing.buyYesPriceUsd ? microToUsd(m.pricing.buyYesPriceUsd) : 0;
    noPrice = m.pricing.buyNoPriceUsd ? microToUsd(m.pricing.buyNoPriceUsd) : 0;
    volume = m.pricing.volume ? microToUsd(m.pricing.volume) : 0;
  } else {
    if (m.yesPriceUsd) yesPrice = microToUsd(m.yesPriceUsd);
    if (m.noPriceUsd) noPrice = microToUsd(m.noPriceUsd);
    if (m.volumeUsd) volume = microToUsd(m.volumeUsd);
  }

  const resolution = m.result || m.resolution;

  return {
    id,
    eventId,
    provider: 'jupiter',
    title,
    yesPrice,
    noPrice,
    volume,
    status,
    resolution: resolution === 'yes' || resolution === 'no' ? resolution : null,
    settlementMint: m.settlementMint,
  };
}

function mapPosition(p: JupPosition): PredictionPosition {
  const contracts = Number(p.contracts);
  const costBasis = microToUsd(p.totalCostUsd);
  const currentValue = p.valueUsd != null ? microToUsd(p.valueUsd) : null;
  const pnl = p.pnlUsd != null ? microToUsd(p.pnlUsd) : null;
  const claimable = p.claimable ?? false;

  let status: PredictionPosition['status'] = 'open';
  if (claimable) status = 'claimable';

  return {
    pubkey: p.pubkey,
    provider: 'jupiter',
    marketId: p.marketId,
    eventId: p.eventId,
    marketTitle: p.marketMetadata?.title ?? '',
    eventTitle: p.eventMetadata?.title ?? '',
    isYes: p.isYes,
    contracts,
    costBasisUsd: costBasis,
    currentValueUsd: currentValue,
    avgPriceUsd: microToUsd(p.avgPriceUsd),
    markPriceUsd: p.markPriceUsd != null ? microToUsd(p.markPriceUsd) : null,
    unrealizedPnlUsd: pnl,
    unrealizedPnlPct: p.pnlUsdPercent ?? null,
    feesPaidUsd: p.feesPaidUsd ? microToUsd(p.feesPaidUsd) : 0,
    claimable,
    payoutUsd: p.payoutUsd ? microToUsd(p.payoutUsd) : 0,
    openedAt: p.openedAt ?? 0,
    status,
  };
}

function mapHistory(h: JupHistoryEntry): PredictionHistoryEntry {
  return {
    id: h.id,
    eventType: h.eventType,
    marketId: h.marketId ?? '',
    eventTitle: h.eventMetadata?.title ?? '',
    marketTitle: h.marketMetadata?.title ?? '',
    isYes: h.isYes ?? true,
    contracts: h.contracts ?? 0,
    priceUsd: h.avgFillPriceUsd ? microToUsd(h.avgFillPriceUsd) : 0,
    feeUsd: h.feeUsd ? microToUsd(h.feeUsd) : 0,
    timestamp: h.timestamp ?? 0,
    signature: h.signature,
  };
}

function mapStatus(s?: string): 'active' | 'closed' | 'resolved' {
  if (s === 'closed' || s === 'resolved') return s;
  return 'active';
}

// ── Sign + send helper ───────────────────────────────────

async function signAndSend(
  walletName: string,
  txBase64: string,
  opts: Parameters<typeof sendEncodedTransaction>[1],
): Promise<{ signature: string; explorerUrl: string }> {
  const signer = await loadSigner(walletName);

  // Decode the raw transaction (preserves existing partial signatures from Jupiter)
  const txBytes = new Uint8Array(Buffer.from(txBase64, 'base64'));
  const rawTx = getTransactionDecoder().decode(txBytes);

  // Sign with our wallet — returns { address: signature } dict
  verbose('Signing prediction transaction...');
  const [newSigs] = await signer.signTransactions([rawTx]);

  // Merge our signature into the existing signatures
  const mergedSigs = { ...rawTx.signatures } as Record<string, unknown>;
  for (const [addr, sig] of Object.entries(newSigs)) {
    mergedSigs[addr] = sig;
  }

  const signedTx = { ...rawTx, signatures: mergedSigs };
  const encodedTx = getBase64EncodedWireTransaction(signedTx as typeof rawTx);

  return sendEncodedTransaction(encodedTx, {
    skipPreflight: false,
    walletName,
    ...opts,
  });
}

// ── Provider implementation ──────────────────────────────

export class JupiterPredictProvider implements PredictProvider {
  name = 'jupiter' as const;

  async listEvents(opts?: {
    category?: string;
    filter?: 'new' | 'live' | 'trending' | 'upcoming';
    sortBy?: 'volume' | 'beginAt';
    limit?: number;
  }): Promise<PredictionEvent[]> {
    const params = new URLSearchParams();
    params.set('includeMarkets', 'true');
    if (opts?.category && opts.category !== 'all') params.set('category', opts.category);
    if (opts?.filter) params.set('filter', opts.filter);
    if (opts?.sortBy) params.set('sortBy', opts.sortBy);
    else params.set('sortBy', 'volume');
    params.set('sortDirection', 'desc');
    const limit = opts?.limit ?? 20;
    params.set('start', '0');
    params.set('end', String(limit));

    const data = await jupFetch<{ data: JupEvent[] }>(`/events?${params}`);
    return (data.data ?? []).map(mapEvent);
  }

  async searchEvents(query: string, limit = 20): Promise<PredictionEvent[]> {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
    });
    const data = await jupFetch<{ data: JupEvent[] }>(`/events/search?${params}`);
    return (data.data ?? []).map(mapEvent);
  }

  async getEvent(eventId: string): Promise<PredictionEvent> {
    const [event, marketsRes] = await Promise.all([
      jupFetch<JupEvent>(`/events/${eventId}`),
      jupFetch<{ data: JupMarket[] }>(`/events/${eventId}/markets`),
    ]);
    const mapped = mapEvent(event);
    mapped.markets = (marketsRes.data ?? []).map(m => mapMarket(m));
    return mapped;
  }

  async getMarket(marketId: string): Promise<PredictionMarket> {
    const m = await jupFetch<JupMarket>(`/markets/${marketId}`);
    return mapMarket(m);
  }

  async getOrderbook(marketId: string): Promise<PredictionOrderbook | null> {
    const raw = await jupFetch<{
      yes?: [number, number][];
      no?: [number, number][];
    } | null>(`/orderbook/${marketId}`);

    if (!raw) return null;
    return {
      yes: (raw.yes ?? []).map(([price, qty]) => ({ price: price / 100, quantity: qty })),
      no: (raw.no ?? []).map(([price, qty]) => ({ price: price / 100, quantity: qty })),
    };
  }

  async buy(
    walletName: string,
    marketId: string,
    isYes: boolean,
    amountUsd: number,
    maxPrice?: number,
  ): Promise<PredictionOrderResult> {
    const signer = await loadSigner(walletName);

    const body: Record<string, unknown> = {
      ownerPubkey: signer.address,
      marketId,
      isYes,
      isBuy: true,
      depositAmount: usdToMicro(amountUsd),
      orderType: 'market',
    };
    if (maxPrice != null) {
      body.maxBuyPriceUsd = usdToMicro(maxPrice);
    }

    const res = await jupFetch<{
      transaction: string;
      order: {
        orderPubkey: string;
        positionPubkey: string;
        contracts: number;
        newAvgPriceUsd: number;
        orderCostUsd: number;
        estimatedTotalFeeUsd: number;
      };
    }>('/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.transaction) {
      throw new Error('Jupiter returned no transaction for buy order');
    }

    const { signature, explorerUrl } = await signAndSend(walletName, res.transaction, {
      txType: 'predict-buy',
      fromMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      fromAmount: String(usdToMicro(amountUsd)),
      toAmount: String(res.order.contracts),
    });

    return {
      orderPubkey: res.order.orderPubkey,
      positionPubkey: res.order.positionPubkey,
      contracts: res.order.contracts,
      priceUsd: microToUsd(res.order.newAvgPriceUsd),
      costUsd: microToUsd(res.order.orderCostUsd),
      estimatedFeeUsd: microToUsd(res.order.estimatedTotalFeeUsd),
      signature,
      explorerUrl,
    };
  }

  async sell(
    walletName: string,
    positionPubkey: string,
    minPrice?: number,
  ): Promise<PredictionCloseResult> {
    const signer = await loadSigner(walletName);

    // First get position details for the response
    const position = await jupFetch<JupPosition>(`/positions/${positionPubkey}`);

    const body: Record<string, unknown> = {
      ownerPubkey: signer.address,
      positionPubkey,
      marketId: position.marketId,
      isYes: position.isYes,
      isBuy: false,
      contracts: Number(position.contracts),
      orderType: 'market',
    };
    if (minPrice != null) {
      body.minSellPriceUsd = usdToMicro(minPrice);
    }

    const res = await jupFetch<{
      transaction: string;
      order: {
        orderPubkey: string;
        contracts: number;
        orderCostUsd: number;
      };
    }>('/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.transaction) {
      throw new Error('Jupiter returned no transaction for sell order');
    }

    const contracts = Number(position.contracts);
    const costBasis = microToUsd(position.totalCostUsd);
    // orderCostUsd may be 0 for sells; fall back to position's current value
    const rawProceeds = res.order.orderCostUsd || 0;
    const proceeds = rawProceeds !== 0
      ? microToUsd(Math.abs(rawProceeds))
      : (position.valueUsd != null ? microToUsd(position.valueUsd) : 0);

    const { signature, explorerUrl } = await signAndSend(walletName, res.transaction, {
      txType: 'predict-sell',
      toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      toAmount: String(Math.abs(res.order.orderCostUsd)),
      fromAmount: String(contracts),
    });

    return {
      positionPubkey,
      contracts,
      proceedsUsd: proceeds,
      realizedPnlUsd: proceeds - costBasis,
      signature,
      explorerUrl,
    };
  }

  async claim(
    walletName: string,
    positionPubkey: string,
  ): Promise<PredictionClaimResult> {
    const signer = await loadSigner(walletName);

    const res = await jupFetch<{
      transaction: string;
      position: {
        positionPubkey: string;
        contracts: number;
        payoutAmountUsd: number;
      };
    }>(`/positions/${positionPubkey}/claim`, {
      method: 'POST',
      body: JSON.stringify({ ownerPubkey: signer.address }),
    });

    if (!res.transaction) {
      throw new Error('Jupiter returned no transaction for claim');
    }

    const { signature, explorerUrl } = await signAndSend(walletName, res.transaction, {
      txType: 'predict-claim',
      toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      toAmount: String(res.position.payoutAmountUsd),
      fromAmount: String(res.position.contracts),
    });

    return {
      positionPubkey,
      contracts: res.position.contracts,
      payoutUsd: microToUsd(res.position.payoutAmountUsd),
      signature,
      explorerUrl,
    };
  }

  async getPositions(walletAddress: string): Promise<PredictionPosition[]> {
    const params = new URLSearchParams({ ownerPubkey: walletAddress });
    const data = await jupFetch<{ data: JupPosition[] }>(`/positions?${params}`);
    return (data.data ?? []).map(mapPosition);
  }

  async getHistory(walletAddress: string, limit = 50): Promise<PredictionHistoryEntry[]> {
    const params = new URLSearchParams({
      ownerPubkey: walletAddress,
      start: '0',
      end: String(limit),
    });
    const data = await jupFetch<{ data: JupHistoryEntry[] }>(`/history?${params}`);
    return (data.data ?? []).map(mapHistory);
  }
}
