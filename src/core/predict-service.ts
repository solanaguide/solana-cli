import { verbose } from '../output/formatter.js';
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
} from './predict/predict-provider.js';
import { PROVIDER_NAMES, type PredictProviderName } from './predict/predict-provider.js';
import { JupiterPredictProvider } from './predict/jupiter-predict-provider.js';

// Re-export types
export type {
  PredictionEvent,
  PredictionMarket,
  PredictionOrderbook,
  PredictionPosition,
  PredictionHistoryEntry,
  PredictionOrderResult,
  PredictionCloseResult,
  PredictionClaimResult,
} from './predict/predict-provider.js';

export { PREDICT_CATEGORIES, PROVIDER_NAMES } from './predict/predict-provider.js';

// ── Provider registry ────────────────────────────────────

const providers: PredictProvider[] = [
  new JupiterPredictProvider(),
];

function getProvider(name: string): PredictProvider {
  const p = providers.find(p => p.name === name);
  if (!p) throw new Error(`Unknown prediction provider: ${name}. Available: ${providers.map(p => p.name).join(', ')}`);
  return p;
}

function resolveProvider(name?: string): string | undefined {
  if (!name) return undefined;
  const normalized = name.toLowerCase();
  if (!PROVIDER_NAMES.includes(normalized as PredictProviderName)) {
    throw new Error(`Unknown provider: ${name}. Available: ${PROVIDER_NAMES.join(', ')}`);
  }
  return normalized;
}

// ── Read operations (aggregate across providers) ─────────

export async function listEvents(opts?: {
  category?: string;
  filter?: 'new' | 'live' | 'trending' | 'upcoming';
  sortBy?: 'volume' | 'beginAt';
  limit?: number;
  provider?: string;
}): Promise<PredictionEvent[]> {
  const proto = resolveProvider(opts?.provider);
  const targets = proto ? [getProvider(proto)] : providers;
  const results = await Promise.allSettled(targets.map(p => p.listEvents(opts)));

  const events: PredictionEvent[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      events.push(...r.value);
    } else {
      verbose(`${targets[i].name} listEvents failed: ${r.reason}`);
    }
  }
  return events;
}

export async function searchEvents(query: string, limit = 20, provider?: string): Promise<PredictionEvent[]> {
  const proto = resolveProvider(provider);
  const targets = proto ? [getProvider(proto)] : providers;
  const results = await Promise.allSettled(targets.map(p => p.searchEvents(query, limit)));

  const events: PredictionEvent[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      events.push(...r.value);
    } else {
      verbose(`${targets[i].name} searchEvents failed: ${r.reason}`);
    }
  }
  return events;
}

export async function getEvent(eventId: string, provider = 'jupiter'): Promise<PredictionEvent> {
  return getProvider(provider).getEvent(eventId);
}

export async function getMarket(marketId: string, provider = 'jupiter'): Promise<PredictionMarket> {
  return getProvider(provider).getMarket(marketId);
}

export async function getOrderbook(marketId: string, provider = 'jupiter'): Promise<PredictionOrderbook | null> {
  return getProvider(provider).getOrderbook(marketId);
}

// ── Write operations (single provider) ───────────────────

export async function buy(
  walletName: string,
  marketId: string,
  isYes: boolean,
  amountUsd: number,
  maxPrice?: number,
  provider = 'jupiter',
): Promise<PredictionOrderResult> {
  return getProvider(provider).buy(walletName, marketId, isYes, amountUsd, maxPrice);
}

export async function sell(
  walletName: string,
  positionPubkey: string,
  minPrice?: number,
  provider = 'jupiter',
): Promise<PredictionCloseResult> {
  return getProvider(provider).sell(walletName, positionPubkey, minPrice);
}

export async function claim(
  walletName: string,
  positionPubkey: string,
  provider = 'jupiter',
): Promise<PredictionClaimResult> {
  return getProvider(provider).claim(walletName, positionPubkey);
}

// ── Positions (for portfolio integration) ────────────────

export async function getPositions(walletAddress: string, provider?: string): Promise<PredictionPosition[]> {
  const proto = resolveProvider(provider);
  const targets = proto ? [getProvider(proto)] : providers;
  const results = await Promise.allSettled(targets.map(p => p.getPositions(walletAddress)));

  const positions: PredictionPosition[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      positions.push(...r.value);
    } else {
      verbose(`${targets[i].name} getPositions failed: ${r.reason}`);
    }
  }
  return positions;
}

export async function getHistory(walletAddress: string, limit = 50, provider?: string): Promise<PredictionHistoryEntry[]> {
  const proto = resolveProvider(provider);
  const targets = proto ? [getProvider(proto)] : providers;
  const results = await Promise.allSettled(targets.map(p => p.getHistory(walletAddress, limit)));

  const entries: PredictionHistoryEntry[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      entries.push(...r.value);
    } else {
      verbose(`${targets[i].name} getHistory failed: ${r.reason}`);
    }
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}
