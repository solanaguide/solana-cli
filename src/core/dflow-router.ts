import { type SwapRouter, type SwapQuoteRequest, type SwapQuoteResult, registerRouter } from './swap-router.js';
import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import { getDFlowBaseUrl, getDFlowHeaders, getDFlowApiKey } from '../utils/dflow-api.js';
import { verbose } from '../output/formatter.js';

const dflowLimiter = new RateLimiter(30, 60_000);

export const dflowRouter: SwapRouter = {
  name: 'dflow',

  async getQuote(req: SwapQuoteRequest): Promise<SwapQuoteResult> {
    if (!getDFlowApiKey()) {
      throw new Error('DFlow requires an API key. Set it with: sol config set api.dflowApiKey <key>');
    }

    await dflowLimiter.acquire();

    const url = `${getDFlowBaseUrl()}/quote?inputMint=${req.inputMint}&outputMint=${req.outputMint}&amount=${req.amount}&slippageBps=${req.slippageBps}`;
    verbose(`Fetching DFlow quote: ${url}`);

    const res = await withRetry(() => fetch(url, { headers: getDFlowHeaders() }), {
      maxRetries: 2,
      shouldRetry: isRetryableHttpError,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DFlow quote failed (${res.status}): ${body}`);
    }

    const data = await res.json() as any;

    return {
      outputAmount: data.outAmount,
      priceImpactPct: parseFloat(data.priceImpactPct || '0'),
      routePlan: data.routePlan?.map((r: any) => r.swapInfo?.label || 'unknown').join(' → ') || 'DFlow',
      raw: data,
    };
  },

  async getSwapTransaction(quote: SwapQuoteResult, userPublicKey: string): Promise<string> {
    await dflowLimiter.acquire();

    const res = await withRetry(
      () => fetch(`${getDFlowBaseUrl()}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getDFlowHeaders() },
        body: JSON.stringify({
          quoteResponse: quote.raw,
          userPublicKey,
        }),
      }),
      { maxRetries: 2, shouldRetry: isRetryableHttpError }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DFlow swap failed (${res.status}): ${body}`);
    }

    const data = await res.json() as any;
    if (!data.swapTransaction) throw new Error('No swap transaction returned from DFlow');
    return data.swapTransaction;
  },
};

// Auto-register on import
registerRouter(dflowRouter);
