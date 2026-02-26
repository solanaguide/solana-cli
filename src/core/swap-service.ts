import { verbose } from '../output/formatter.js';
import { resolveToken } from './token-registry.js';
import { uiToTokenAmount, SOL_MINT } from '../utils/solana.js';
import { loadSigner } from './wallet-manager.js';
import {
  getTransactionDecoder,
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
import { createNoopInstruction } from '../utils/noop.js';
import { getPrices } from './price-service.js';
import { getRpc } from './rpc.js';
import { getRouterQuote, getRouter } from './swap-router.js';

// Import routers so they self-register
import './jupiter-router.js';
import './dflow-router.js';

const COMPASS_RESERVE = address('8H2xjMT543YWBLRjJ24BrQyBgFuQRU6MgENA3mqXoh7y');
const MIN_REWARD_BPS = 2;
const MAX_REWARD_BPS = 100;
const REWARD_CURVE_K = 0.7;

function rewardBpsFromCost(effectiveCostPct: number): number {
  const t = 1 - Math.exp(-REWARD_CURVE_K * Math.abs(effectiveCostPct));
  return Math.round(MIN_REWARD_BPS + (MAX_REWARD_BPS - MIN_REWARD_BPS) * t);
}

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
  routerName: string;
  platformFee?: string;
  // Router-specific data kept for swap execution
  _raw: unknown;
  _routerName: string;
}

export interface SwapResult {
  signature: string;
  inputSymbol: string;
  outputSymbol: string;
  inputAmount: number;
  outputAmount: number;
  explorerUrl: string;
  routerName: string;
}

export async function getQuote(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  opts: { slippageBps?: number; router?: string } = {}
): Promise<SwapQuote> {
  const inputToken = await resolveToken(inputSymbol);
  if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

  const outputToken = await resolveToken(outputSymbol);
  if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

  const inputAmount = uiToTokenAmount(amount, inputToken.decimals);
  const slippageBps = opts.slippageBps ?? 50;

  const { quote, router } = await getRouterQuote({
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    amount: String(inputAmount),
    slippageBps,
  }, opts.router);

  const outputUiAmount = Number(BigInt(quote.outputAmount)) / Math.pow(10, outputToken.decimals);

  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    inputAmount: String(inputAmount),
    outputAmount: quote.outputAmount,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    inputUiAmount: amount,
    outputUiAmount,
    priceImpactPct: quote.priceImpactPct,
    slippageBps,
    routePlan: quote.routePlan,
    routerName: router.name,
    _raw: quote,
    _routerName: router.name,
  };
}

export async function executeSwap(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  walletName: string,
  opts: { slippageBps?: number; skipPreflight?: boolean; rewardBps?: number; router?: string } = {}
): Promise<SwapResult> {
  const quote = await getQuote(inputSymbol, outputSymbol, amount, {
    slippageBps: opts.slippageBps,
    router: opts.router,
  });
  const signer = await loadSigner(walletName);
  const rpc = getRpc();

  let fromPriceUsd: number | undefined;
  let toPriceUsd: number | undefined;
  try {
    const prices = await getPrices([quote.inputMint, quote.outputMint]);
    fromPriceUsd = prices.get(quote.inputMint)?.priceUsd;
    toPriceUsd = prices.get(quote.outputMint)?.priceUsd;
  } catch {
    verbose('Could not fetch prices');
  }

  const inputIsSol = quote.inputMint === SOL_MINT;
  const outputIsSol = quote.outputMint === SOL_MINT;
  let rewardBps: number;
  if (opts.rewardBps != null) {
    rewardBps = opts.rewardBps;
  } else if (fromPriceUsd && toPriceUsd && fromPriceUsd > 0) {
    const inputUsd = quote.inputUiAmount * fromPriceUsd;
    const outputUsd = quote.outputUiAmount * toPriceUsd;
    const effectiveCostPct = (1 - outputUsd / inputUsd) * 100;
    rewardBps = rewardBpsFromCost(effectiveCostPct);
  } else {
    rewardBps = MIN_REWARD_BPS;
  }

  let contributionLamports = 0n;
  if (inputIsSol) {
    contributionLamports = BigInt(quote.inputAmount) * BigInt(rewardBps) / 10000n;
  } else if (outputIsSol) {
    contributionLamports = BigInt(quote.outputAmount) * BigInt(rewardBps) / 10000n;
  }

  // Get swap transaction from the router that produced the quote
  const router = getRouter(quote._routerName);
  if (!router) throw new Error(`Router ${quote._routerName} not found`);

  const swapTxBase64 = await router.getSwapTransaction(quote._raw as any, signer.address);

  // Decode and decompile the transaction
  const txBytes = new Uint8Array(Buffer.from(swapTxBase64, 'base64'));
  const rawTx = getTransactionDecoder().decode(txBytes);
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(rawTx.messageBytes);
  let msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

  // Append SOL transfer to reserve if applicable
  if (contributionLamports > 0n) {
    verbose(`Appending ${contributionLamports} lamport contribution to reserve`);
    const transferIx = getTransferSolInstruction({
      source: signer,
      destination: COMPASS_RESERVE,
      amount: contributionLamports,
    });
    msg = appendTransactionMessageInstructions([transferIx], msg) as typeof msg;
  }

  // Append noop for on-chain tracking
  msg = appendTransactionMessageInstructions([createNoopInstruction()], msg) as typeof msg;

  // Sign and encode
  verbose('Signing swap transaction...');
  const signedTx = await signTransactionMessageWithSigners(msg);
  const encodedTx = getBase64EncodedWireTransaction(signedTx);

  // Send, confirm, and log
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
    routerName: quote.routerName,
  };
}
