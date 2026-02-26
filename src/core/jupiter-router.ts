import { type SwapRouter, type SwapQuoteRequest, type SwapQuoteResult, registerRouter } from './swap-router.js';
import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import { getJupiterBaseUrl, getJupiterHeaders } from '../utils/jupiter-api.js';
import { verbose } from '../output/formatter.js';

const jupiterLimiter = new RateLimiter(30, 60_000);

function getJupiterSwapUrl(): string {
  return `${getJupiterBaseUrl()}/swap/v1`;
}

export const jupiterRouter: SwapRouter = {
  name: 'jupiter',

  async getQuote(req: SwapQuoteRequest): Promise<SwapQuoteResult> {
    await jupiterLimiter.acquire();

    const url = `${getJupiterSwapUrl()}/quote?inputMint=${req.inputMint}&outputMint=${req.outputMint}&amount=${req.amount}&slippageBps=${req.slippageBps}`;
    verbose(`Fetching Jupiter quote: ${url}`);

    const res = await withRetry(() => fetch(url, { headers: getJupiterHeaders() }), {
      maxRetries: 2,
      shouldRetry: isRetryableHttpError,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
    }

    const data = await res.json() as any;

    return {
      outputAmount: data.outAmount,
      priceImpactPct: parseFloat(data.priceImpactPct || '0'),
      routePlan: data.routePlan?.map((r: any) => r.swapInfo?.label || 'unknown').join(' → ') || 'direct',
      raw: data,
    };
  },

  async getSwapTransaction(quote: SwapQuoteResult, userPublicKey: string): Promise<string> {
    await jupiterLimiter.acquire();

    const res = await withRetry(
      () => fetch(`${getJupiterSwapUrl()}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getJupiterHeaders() },
        body: JSON.stringify({
          quoteResponse: quote.raw,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jupiter swap failed (${res.status}): ${body}`);
    }

    const data = await res.json() as any;
    if (!data.swapTransaction) throw new Error('No swap transaction returned from Jupiter');
    return data.swapTransaction;
  },
};

// Auto-register on import
registerRouter(jupiterRouter);
