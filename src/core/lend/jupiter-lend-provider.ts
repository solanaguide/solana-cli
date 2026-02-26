import {
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getJupiterApiKey, getJupiterBaseUrl } from '../../utils/jupiter-api.js';
import { loadSigner } from '../wallet-manager.js';
import { resolveToken, type TokenMetadata } from '../token-registry.js';
import { sendEncodedTransaction } from '../transaction.js';
import { getRpc } from '../rpc.js';
import { getPrices } from '../price-service.js';
import { verbose } from '../../output/formatter.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';

function getJupLendBase(): string {
  return `${getJupiterBaseUrl()}/lend/v1`;
}

// ── HTTP helper ──────────────────────────────────────────

function getHeaders(): Record<string, string> {
  const apiKey = getJupiterApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

async function jupLendFetch(path: string, init?: RequestInit): Promise<any> {
  const url = `${getJupLendBase()}${path}`;
  verbose(`Jupiter Lend API: ${init?.method ?? 'GET'} ${url}`);

  const resp = await fetch(url, {
    ...init,
    headers: { ...getHeaders(), ...init?.headers },
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      'Jupiter Lend API key required or invalid. ' +
      'Get one at https://portal.jup.ag and run: sol config set api.jupiterApiKey YOUR_KEY'
    );
  }

  if (resp.status === 429) {
    throw new Error(
      'Jupiter Lend API rate limited. ' +
      'For better limits, get an API key at https://portal.jup.ag and run: sol config set api.jupiterApiKey YOUR_KEY'
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Jupiter Lend API error ${resp.status}: ${body}`);
  }

  return resp.json();
}

// ── Helpers ───────────────────────────────────────────────

async function resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
  const meta = await resolveToken(symbolOrMint);
  if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
  return meta;
}

/**
 * Decode a base64 unsigned transaction from Jupiter, sign it, and send it.
 * Same pattern as swap-service.ts.
 */
async function signAndSendJupiterTx(
  base64Tx: string,
  signer: any,
  txOpts?: Parameters<typeof sendEncodedTransaction>[1],
): Promise<string> {
  const rpc = getRpc();

  // Decode the transaction
  const txBytes = Buffer.from(base64Tx, 'base64');
  const tx = getTransactionDecoder().decode(txBytes);

  // Decompile to message, inject signer, sign, recompile
  const compiledMsg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

  // Replace the fee payer/signer with our signer
  const signedMsg = Object.assign({}, msg, { feePayer: signer });
  const signedTx = await signTransactionMessageWithSigners(signedMsg);
  const encoded = getBase64EncodedWireTransaction(signedTx);

  const result = await sendEncodedTransaction(encoded, txOpts);
  return result.signature;
}

// ── Provider ─────────────────────────────────────────────

export class JupiterLendProvider implements LendProvider {
  name = 'jup-lend' as const;
  capabilities = { deposit: true, withdraw: true, borrow: false, repay: false };

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const data = await jupLendFetch('/earn/tokens');

    // data is an array of token info objects
    const rates: LendingRate[] = [];
    for (const item of data) {
      const symbol = item.asset?.symbol ?? item.symbol;
      const assetMint = item.assetAddress ?? item.asset?.address;
      if (!assetMint) continue;

      // Filter
      if (tokens && tokens.length > 0) {
        const match = tokens.some(t =>
          t.toUpperCase() === symbol?.toUpperCase() ||
          t === assetMint
        );
        if (!match) continue;
      }

      const decimals = item.asset?.decimals ?? item.decimals ?? 6;
      const mintFactor = Math.pow(10, decimals);

      // rates are in 1e4 (e.g. "500" = 5%)
      const totalRate = parseFloat(item.totalRate ?? '0') / 10_000;
      const totalAssets = parseFloat(item.totalAssets ?? '0') / mintFactor;

      rates.push({
        protocol: 'jup-lend',
        token: symbol || 'unknown',
        mint: assetMint,
        depositApy: totalRate,
        borrowApy: 0, // Jupiter Lend is deposit-only
        totalDeposited: totalAssets,
        totalBorrowed: 0,
        utilizationPct: 0,
      });
    }

    return rates;
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    verbose(`Fetching Jupiter Lend positions for ${walletAddress}`);

    const data = await jupLendFetch(`/earn/positions?users=${walletAddress}`);

    const positions: LendingPosition[] = [];
    for (const item of data) {
      const tokenInfo = item.token;
      const symbol = tokenInfo?.asset?.symbol ?? tokenInfo?.symbol;
      const assetMint = tokenInfo?.assetAddress ?? tokenInfo?.asset?.address;
      if (!assetMint) continue;

      const decimals = tokenInfo?.asset?.decimals ?? tokenInfo?.decimals ?? 6;
      const mintFactor = Math.pow(10, decimals);

      const underlyingAssets = parseFloat(item.underlyingAssets ?? '0') / mintFactor;
      if (underlyingAssets <= 0) continue;

      const totalRate = parseFloat(tokenInfo?.totalRate ?? '0') / 10_000;
      const price = parseFloat(tokenInfo?.asset?.price ?? '0');

      positions.push({
        protocol: 'jup-lend',
        token: symbol || 'unknown',
        mint: assetMint,
        type: 'deposit',
        amount: underlyingAssets,
        valueUsd: underlyingAssets * price,
        apy: totalRate,
      });
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const resp = await jupLendFetch('/earn/deposit', {
      method: 'POST',
      body: JSON.stringify({
        asset: meta.mint,
        amount: rawAmount,
        signer: signer.address,
      }),
    });

    if (!resp.transaction) {
      throw new Error('Jupiter Lend API did not return a transaction');
    }

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const signature = await signAndSendJupiterTx(resp.transaction, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    const { explorerUrl } = await import('../../utils/solana.js');

    return {
      signature,
      protocol: 'jup-lend',
      explorerUrl: explorerUrl(signature),
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);

    let rawAmount: string;
    if (!isFinite(amount)) {
      // Fetch raw underlying amount directly from API (avoids precision loss from UI→raw)
      const data = await jupLendFetch(`/earn/positions?users=${signer.address}`);
      const pos = data.find((item: any) => {
        const assetMint = item.token?.assetAddress ?? item.token?.asset?.address;
        return assetMint === meta.mint;
      });
      if (!pos) throw new Error(`No Jupiter Lend position found for ${meta.symbol}`);
      rawAmount = pos.underlyingAssets ?? uiToTokenAmount(amount, meta.decimals).toString();
    } else {
      rawAmount = uiToTokenAmount(amount, meta.decimals).toString();
    }

    const resp = await jupLendFetch('/earn/withdraw', {
      method: 'POST',
      body: JSON.stringify({
        asset: meta.mint,
        amount: rawAmount,
        signer: signer.address,
      }),
    });

    if (!resp.transaction) {
      throw new Error('Jupiter Lend API did not return a transaction');
    }

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const signature = await signAndSendJupiterTx(resp.transaction, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    const { explorerUrl } = await import('../../utils/solana.js');

    return {
      signature,
      protocol: 'jup-lend',
      explorerUrl: explorerUrl(signature),
    };
  }
}
