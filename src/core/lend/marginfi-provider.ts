import { MarginfiClient, getConfig, type MarginfiAccountWrapper } from '@mrgnlabs/marginfi-client-v2';
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  generateKeyPairSigner,
  type Instruction,
  type AccountMeta,
  address as kitAddress,
} from '@solana/kit';
import { getV1Connection, DummyWallet, toV2Instructions } from './marginfi-compat.js';
import { loadSigner, loadSignerRawBytes } from '../wallet-manager.js';
import { resolveToken, type TokenMetadata } from '../token-registry.js';
import { getPrices } from '../price-service.js';
import { buildAndSendTransaction } from '../transaction.js';
import { verbose } from '../../output/formatter.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';
import { MarginRequirementType } from '@mrgnlabs/marginfi-client-v2';

// ── Client caching ───────────────────────────────────────

let cachedClient: MarginfiClient | null = null;
let clientLoadedAt = 0;
const CLIENT_TTL_MS = 60_000;

/**
 * Load a MarginFi client.
 * For read-only ops, uses a dummy wallet. For write ops, pass the wallet address
 * so account derivation (PDAs) uses the correct authority.
 */
async function loadClient(walletAddress?: string): Promise<MarginfiClient> {
  const now = Date.now();
  if (cachedClient && (now - clientLoadedAt) < CLIENT_TTL_MS && !walletAddress) {
    return cachedClient;
  }

  verbose('Loading MarginFi client...');
  const config = getConfig('production');
  const connection = getV1Connection();

  // DummyWallet for account derivation — signing is done via our v2 pipeline
  const wallet = walletAddress
    ? new DummyWallet(walletAddress)
    : new DummyWallet(Keypair.generate().publicKey.toBase58());

  const client = await MarginfiClient.fetch(config, wallet as any, connection as any);

  if (!walletAddress) {
    cachedClient = client;
    clientLoadedAt = now;
  }

  return client;
}

// ── Helpers ───────────────────────────────────────────────

async function resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
  const meta = await resolveToken(symbolOrMint);
  if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
  return meta;
}

async function getExistingAccount(
  client: MarginfiClient,
  walletPubkey: PublicKey,
): Promise<MarginfiAccountWrapper | null> {
  const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
  return accounts.length > 0 ? accounts[0] : null;
}

/**
 * Build create-account instructions with a v2-compatible ephemeral signer.
 * Returns both the v2 instructions (with signer injected) and the ephemeral signer.
 */
async function buildCreateAccountIxs(client: MarginfiClient): Promise<Instruction[]> {
  const ephemeral = await generateKeyPairSigner();
  const { instructions } = await client.makeCreateMarginfiAccountIx(
    new PublicKey(ephemeral.address),
  );

  // Convert to v2, then replace the ephemeral account address with the actual signer
  // so signTransactionMessageWithSigners picks it up
  const v2Ixs = toV2Instructions(instructions);
  return v2Ixs.map(ix => ({
    ...ix,
    accounts: (ix.accounts ?? []).map((acc: AccountMeta) => {
      if (acc.address === ephemeral.address && (acc.role === 2 || acc.role === 3)) {
        return { ...acc, signer: ephemeral } as any;
      }
      return acc;
    }),
  }));
}

function computeHealthFactor(account: MarginfiAccountWrapper): number | undefined {
  try {
    const health = account.computeHealthComponents(MarginRequirementType.Maintenance);
    const liabilities = health.liabilities.toNumber();
    if (liabilities <= 0) return undefined;
    return health.assets.toNumber() / liabilities;
  } catch {
    return undefined;
  }
}

/**
 * Send Switchboard Pull oracle update transaction if needed.
 * MarginFi banks using SwitchboardPull oracles require a feed crank
 * in a separate transaction before borrow/withdraw operations.
 */
async function sendOracleUpdateIfNeeded(
  account: MarginfiAccountWrapper,
  bankAddresses: PublicKey[],
  walletName: string,
): Promise<void> {
  const { instructions: feedIxs, luts: feedLuts } = await account.makeUpdateFeedIx(bankAddresses);
  if (feedIxs.length === 0) return;

  verbose(`Sending Switchboard oracle update (${feedIxs.length} instructions)...`);
  const connection = getV1Connection();
  const rawBytes = loadSignerRawBytes(walletName);
  const v1Keypair = Keypair.fromSecretKey(rawBytes);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    instructions: feedIxs,
    payerKey: v1Keypair.publicKey,
    recentBlockhash: blockhash,
  }).compileToV0Message(feedLuts);

  const tx = new VersionedTransaction(msg);
  tx.sign([v1Keypair]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 0,
  });
  verbose(`Oracle update sent: ${sig}`);

  // Wait for confirmation
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const result = await connection.getSignatureStatus(sig);
    if (result.value?.confirmationStatus === 'confirmed' || result.value?.confirmationStatus === 'finalized') {
      verbose('Oracle update confirmed');
      return;
    }
    if (result.value?.err) {
      verbose(`Oracle update failed: ${JSON.stringify(result.value.err)} — proceeding anyway`);
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  verbose('Oracle update confirmation timeout — proceeding anyway');
}

// ── Provider ─────────────────────────────────────────────

export class MarginfiProvider implements LendProvider {
  name = 'marginfi' as const;
  capabilities = { deposit: true, withdraw: true, borrow: true, repay: true };

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const client = await loadClient();
    const rates: LendingRate[] = [];

    for (const [, bank] of client.banks) {
      const symbol = bank.tokenSymbol ?? '';
      if (!symbol) continue;

      // Filter if tokens specified
      if (tokens && tokens.length > 0) {
        const match = tokens.some(t =>
          t.toUpperCase() === symbol.toUpperCase() ||
          t === bank.mint.toBase58()
        );
        if (!match) continue;
      }

      const interestRates = bank.computeInterestRates();
      const mintFactor = Math.pow(10, bank.mintDecimals);

      rates.push({
        protocol: 'marginfi',
        token: symbol,
        mint: bank.mint.toBase58(),
        depositApy: interestRates.lendingRate.toNumber(),
        borrowApy: interestRates.borrowingRate.toNumber(),
        totalDeposited: bank.getTotalAssetQuantity().toNumber() / mintFactor,
        totalBorrowed: bank.getTotalLiabilityQuantity().toNumber() / mintFactor,
        utilizationPct: bank.computeUtilizationRate().toNumber() * 100,
      });
    }

    return rates;
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    verbose(`Fetching MarginFi positions for ${walletAddress}`);
    const client = await loadClient(walletAddress);
    const walletPubkey = new PublicKey(walletAddress);

    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) return [];

    const positions: LendingPosition[] = [];

    for (const account of accounts) {
      const healthFactor = computeHealthFactor(account);

      for (const balance of account.activeBalances) {
        const bank = client.getBankByPk(balance.bankPk);
        if (!bank) continue;

        const qty = balance.computeQuantityUi(bank);
        const usdValue = balance.computeUsdValue(bank, client.oraclePrices.get(balance.bankPk.toBase58())!);
        const interestRates = bank.computeInterestRates();
        const symbol = bank.tokenSymbol ?? bank.mint.toBase58().slice(0, 8);

        const assets = qty.assets.toNumber();
        const liabilities = qty.liabilities.toNumber();

        if (assets > 0) {
          positions.push({
            protocol: 'marginfi',
            token: symbol,
            mint: bank.mint.toBase58(),
            type: 'deposit',
            amount: assets,
            valueUsd: usdValue.assets.toNumber(),
            apy: interestRates.lendingRate.toNumber(),
          });
        }

        if (liabilities > 0) {
          positions.push({
            protocol: 'marginfi',
            token: symbol,
            mint: bank.mint.toBase58(),
            type: 'borrow',
            amount: liabilities,
            valueUsd: usdValue.liabilities.toNumber(),
            apy: interestRates.borrowingRate.toNumber(),
            healthFactor,
          });
        }
      }
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    let account = await getExistingAccount(client, walletPubkey);

    // First-time: create a MarginFi account in a separate tx
    if (!account) {
      verbose('No MarginFi account — creating one...');
      const createIxs = await buildCreateAccountIxs(client);
      await buildAndSendTransaction(createIxs, signer, {
        txType: 'lend-create-account',
        walletName,
      });

      // Reload client and fetch the newly created account
      const refreshed = await loadClient(signer.address);
      account = await getExistingAccount(refreshed, walletPubkey);
      if (!account) throw new Error('Failed to create MarginFi account');
    }

    const ixResult = await account.makeDepositIx(amount, bank.address);
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) throw new Error('No MarginFi account found');
    const account = accounts[0];

    // Crank Switchboard Pull oracles before withdraw (health check needs fresh prices)
    await sendOracleUpdateIfNeeded(account, [], walletName);

    const withdrawAll = !isFinite(amount);
    const ixResult = await account.makeWithdrawIx(
      withdrawAll ? 0 : amount,
      bank.address,
      withdrawAll,
    );
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
    };
  }

  async borrow(walletName: string, token: string, amount: number, _collateral: string): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) throw new Error('No MarginFi account found. Deposit collateral first.');
    const account = accounts[0];

    // Crank Switchboard Pull oracles before borrow (health check needs fresh prices)
    await sendOracleUpdateIfNeeded(account, [bank.address], walletName);

    const ixResult = await account.makeBorrowIx(amount, bank.address);
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    // Fetch health factor (best-effort)
    let healthFactor: number | undefined;
    try {
      const refreshed = await loadClient(signer.address);
      const accts = await refreshed.getMarginfiAccountsForAuthority(walletPubkey);
      if (accts.length > 0) healthFactor = computeHealthFactor(accts[0]);
    } catch { /* non-critical */ }

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
      healthFactor,
    };
  }

  async repay(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await resolveTokenStrict(token);
    const signer = await loadSigner(walletName);
    const client = await loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) throw new Error('No MarginFi account found');
    const account = accounts[0];

    const repayAll = !isFinite(amount);
    const ixResult = await account.makeRepayIx(
      repayAll ? 0 : amount,
      bank.address,
      repayAll,
    );
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await buildAndSendTransaction(instructions, signer, {
      txType: 'lend-repay',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    // Fetch remaining debt (best-effort)
    let remainingDebt: number | undefined;
    try {
      const refreshed = await loadClient(signer.address);
      const accts = await refreshed.getMarginfiAccountsForAuthority(walletPubkey);
      if (accts.length > 0) {
        for (const bal of accts[0].activeBalances) {
          const b = client.getBankByPk(bal.bankPk);
          if (b && b.mint.toBase58() === meta.mint) {
            const qty = bal.computeQuantityUi(b);
            remainingDebt = qty.liabilities.toNumber();
            break;
          }
        }
      }
    } catch { /* non-critical */ }

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
      remainingDebt,
    };
  }
}
