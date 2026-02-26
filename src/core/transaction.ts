import {
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  type TransactionSigner,
  type IInstruction,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { getBase64EncodedWireTransaction } from '@solana/transactions';
import { getRpc } from './rpc.js';
import { verbose } from '../output/formatter.js';
import { getDb } from '../db/database.js';
import { explorerUrl } from '../utils/solana.js';
import { createNoopInstruction } from '../utils/noop.js';

export enum ErrorClass {
  RETRYABLE_TRANSIENT = 'RETRYABLE_TRANSIENT',
  RETRYABLE_EXPIRED = 'RETRYABLE_EXPIRED',
  RETRYABLE_STALE_QUOTE = 'RETRYABLE_STALE_QUOTE',
  TERMINAL_PROGRAM = 'TERMINAL_PROGRAM',
  TERMINAL_SIMULATION = 'TERMINAL_SIMULATION',
  TERMINAL_UNKNOWN = 'TERMINAL_UNKNOWN',
}

export function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes('BlockheightExceeded') || msg.includes('blockhash') || msg.includes('Blockhash not found')) {
    return ErrorClass.RETRYABLE_EXPIRED;
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too many requests')) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('5') && (msg.includes('Internal') || msg.includes('server'))) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND')) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('-32005')) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('insufficient') || msg.includes('Insufficient')) {
    return ErrorClass.TERMINAL_PROGRAM;
  }
  if (msg.includes('simulation failed') || msg.includes('SimulationFailed')) {
    return ErrorClass.TERMINAL_SIMULATION;
  }
  if (msg.includes('Program error') || msg.includes('custom program error')) {
    return ErrorClass.TERMINAL_PROGRAM;
  }

  return ErrorClass.TERMINAL_UNKNOWN;
}

// ── Transaction logging ────────────────────────────────────

export interface TxLogEntry {
  signature: string;
  type: string;
  walletName?: string;
  fromMint?: string;
  toMint?: string;
  fromAmount?: string;
  toAmount?: string;
  fromPriceUsd?: number;
  toPriceUsd?: number;
  status: string;
  error?: string;
}

export function logTransaction(entry: TxLogEntry): void {
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO transaction_log
        (signature, type, wallet_name, from_mint, to_mint, from_amount, to_amount, from_price_usd, to_price_usd, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.signature,
      entry.type,
      entry.walletName ?? null,
      entry.fromMint ?? null,
      entry.toMint ?? null,
      entry.fromAmount ?? null,
      entry.toAmount ?? null,
      entry.fromPriceUsd ?? null,
      entry.toPriceUsd ?? null,
      entry.status,
      entry.error ?? null,
    );
  } catch {
    // Non-critical — never fail a transaction because logging broke
  }
}

export function updateTransactionStatus(signature: string, status: string, error?: string): void {
  try {
    getDb().prepare(
      'UPDATE transaction_log SET status = ?, error = ? WHERE signature = ?'
    ).run(status, error ?? null, signature);
  } catch { /* non-critical */ }
}

// ── Send + confirm ─────────────────────────────────────────

export interface SendResult {
  signature: string;
  status: string;
  attempts: number;
  elapsed_ms: number;
  explorerUrl: string;
}

/**
 * Inject TransactionSigner references into instruction accounts that match known signers.
 * v1→v2 instruction conversions only produce role bits (2=READONLY_SIGNER, 3=WRITABLE_SIGNER)
 * without actual signer objects. signTransactionMessageWithSigners requires IAccountSignerMeta
 * entries to find signers, so we inject them here.
 */
function injectSigners(
  instructions: IInstruction[],
  signers: TransactionSigner[],
): IInstruction[] {
  const signerMap = new Map(signers.map(s => [s.address, s]));
  return instructions.map(ix => ({
    ...ix,
    accounts: (ix.accounts ?? []).map((acc: any) => {
      if ((acc.role === 2 || acc.role === 3) && signerMap.has(acc.address) && !acc.signer) {
        return { ...acc, signer: signerMap.get(acc.address)! };
      }
      return acc;
    }),
  }));
}

export async function buildAndSendTransaction(
  instructions: IInstruction[],
  payer: TransactionSigner,
  opts: {
    maxRetries?: number;
    skipPreflight?: boolean;
    txType?: string;
    walletName?: string;
    fromMint?: string;
    toMint?: string;
    fromAmount?: string;
    toAmount?: string;
    fromPriceUsd?: number;
    toPriceUsd?: number;
  } = {}
): Promise<SendResult> {
  const rpc = getRpc();
  const maxRetries = opts.maxRetries ?? 3;
  const start = performance.now();
  let attempts = 0;
  let lastSignature: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    attempts++;
    try {
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

      const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayer(payer.address, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m => appendTransactionMessageInstructions(injectSigners([...instructions, createNoopInstruction()], [payer]), m),
      );

      const signedTx = await signTransactionMessageWithSigners(message);
      const signature = getSignatureFromTransaction(signedTx);
      lastSignature = signature;
      const encodedTx = getBase64EncodedWireTransaction(signedTx);

      // Log as pending before sending
      logTransaction({
        signature,
        type: opts.txType ?? 'unknown',
        walletName: opts.walletName,
        fromMint: opts.fromMint,
        toMint: opts.toMint,
        fromAmount: opts.fromAmount,
        toAmount: opts.toAmount,
        fromPriceUsd: opts.fromPriceUsd,
        toPriceUsd: opts.toPriceUsd,
        status: 'sending',
      });

      await rpc.sendTransaction(encodedTx, {
        skipPreflight: opts.skipPreflight ?? false,
        encoding: 'base64',
      }).send();

      verbose(`Transaction sent: ${signature}, waiting for confirmation...`);
      updateTransactionStatus(signature, 'sent');

      // Poll for confirmation
      await pollConfirmation(rpc, signature, 30_000);

      const elapsed_ms = Math.round(performance.now() - start);
      updateTransactionStatus(signature, 'confirmed');

      return {
        signature,
        status: 'confirmed',
        attempts,
        elapsed_ms,
        explorerUrl: explorerUrl(signature),
      };
    } catch (err) {
      const errorClass = classifyError(err);
      verbose(`Transaction attempt ${attempt + 1} failed: ${errorClass} — ${err}`);

      // Extract and log simulation logs from SolanaError context
      const ctx = (err as any)?.context;
      if (ctx?.logs?.length) {
        verbose('Transaction logs:');
        for (const log of ctx.logs) verbose(`  ${log}`);
      }

      if (lastSignature) {
        updateTransactionStatus(lastSignature, 'failed', String(err));
      }

      if (errorClass === ErrorClass.RETRYABLE_EXPIRED || errorClass === ErrorClass.RETRYABLE_TRANSIENT) {
        if (attempt < maxRetries - 1) continue;
      }
      throw err;
    }
  }

  throw new Error('Max transaction retries exceeded');
}

// ── Send pre-built transaction (e.g. Jupiter swap) ─────────

export async function sendEncodedTransaction(
  encodedTx: string,
  opts: {
    skipPreflight?: boolean;
    txType?: string;
    walletName?: string;
    fromMint?: string;
    toMint?: string;
    fromAmount?: string;
    toAmount?: string;
    fromPriceUsd?: number;
    toPriceUsd?: number;
  } = {}
): Promise<SendResult> {
  const rpc = getRpc();
  const start = performance.now();

  // We don't know the signature until we parse or send, but Jupiter gives it back
  // Log with a placeholder, update after

  const signature = await rpc.sendTransaction(encodedTx as any, {
    skipPreflight: opts.skipPreflight ?? false,
    encoding: 'base64',
  }).send();

  const sigStr = String(signature);

  logTransaction({
    signature: sigStr,
    type: opts.txType ?? 'unknown',
    walletName: opts.walletName,
    fromMint: opts.fromMint,
    toMint: opts.toMint,
    fromAmount: opts.fromAmount,
    toAmount: opts.toAmount,
    fromPriceUsd: opts.fromPriceUsd,
    toPriceUsd: opts.toPriceUsd,
    status: 'sent',
  });

  verbose(`Transaction sent: ${sigStr}, waiting for confirmation...`);

  try {
    await pollConfirmation(rpc, sigStr, 30_000);
    updateTransactionStatus(sigStr, 'confirmed');
  } catch (err) {
    updateTransactionStatus(sigStr, 'failed', String(err));
    throw err;
  }

  const elapsed_ms = Math.round(performance.now() - start);

  return {
    signature: sigStr,
    status: 'confirmed',
    attempts: 1,
    elapsed_ms,
    explorerUrl: explorerUrl(sigStr),
  };
}

// ── Confirmation polling ───────────────────────────────────

async function pollConfirmation(rpc: Rpc<SolanaRpcApi>, signature: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await rpc.getSignatureStatuses([signature as any]).send();
      const status = result.value[0];
      if (status) {
        if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed')) {
        throw err;
      }
      verbose(`Polling error (will retry): ${err}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Transaction confirmation timeout');
}
