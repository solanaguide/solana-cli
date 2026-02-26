import { verbose } from '../output/formatter.js';
import { getConfigValue } from './config-manager.js';

export interface SwapQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;        // raw token amount (lamports/smallest unit)
  slippageBps: number;
}

export interface SwapQuoteResult {
  outputAmount: string;  // raw token amount
  priceImpactPct: number;
  routePlan: string;     // human-readable route description
  raw: unknown;          // router-specific data needed for swap execution
}

export interface SwapRouter {
  name: string;
  getQuote(req: SwapQuoteRequest): Promise<SwapQuoteResult>;
  getSwapTransaction(quote: SwapQuoteResult, userPublicKey: string): Promise<string>; // base64 tx
}

const routers = new Map<string, SwapRouter>();

export function registerRouter(router: SwapRouter): void {
  routers.set(router.name, router);
}

export function getRouter(name: string): SwapRouter | undefined {
  return routers.get(name);
}

export function getAllRouters(): SwapRouter[] {
  return [...routers.values()];
}

export function getDefaultRouterName(): string {
  return (getConfigValue('defaults.router') as string) ?? 'best';
}

export async function getBestQuote(
  req: SwapQuoteRequest
): Promise<{ quote: SwapQuoteResult; router: SwapRouter }> {
  const all = getAllRouters();
  if (all.length === 0) throw new Error('No swap routers registered');

  const results = await Promise.allSettled(
    all.map(async r => ({ quote: await r.getQuote(req), router: r }))
  );

  let best: { quote: SwapQuoteResult; router: SwapRouter } | undefined;

  for (const r of results) {
    if (r.status === 'rejected') {
      verbose(`Router quote failed: ${r.reason}`);
      continue;
    }
    if (!best || BigInt(r.value.quote.outputAmount) > BigInt(best.quote.outputAmount)) {
      best = r.value;
    }
  }

  if (!best) {
    // All routers failed — rethrow the first error
    const firstError = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    throw firstError.reason;
  }

  verbose(`Best quote from ${best.router.name}: ${best.quote.outputAmount}`);
  return best;
}

export async function getRouterQuote(
  req: SwapQuoteRequest,
  routerName?: string
): Promise<{ quote: SwapQuoteResult; router: SwapRouter }> {
  const name = routerName ?? getDefaultRouterName();

  if (name === 'best') {
    return getBestQuote(req);
  }

  const router = getRouter(name);
  if (!router) throw new Error(`Unknown router: ${name}. Available: ${getAllRouters().map(r => r.name).join(', ')}`);

  const quote = await router.getQuote(req);
  return { quote, router };
}
