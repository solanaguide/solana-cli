import { getRpc } from './rpc.js';
import { address, lamports, type Address } from '@solana/kit';
import { resolveToken, type TokenMetadata } from './token-registry.js';
import { lamportsToSol, tokenAmountToUi, SOL_MINT, SOL_DECIMALS } from '../utils/solana.js';
import { verbose } from '../output/formatter.js';

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;      // raw amount string
  uiBalance: number;    // human-readable amount
}

export async function getSolBalance(addr: string): Promise<number> {
  const rpc = getRpc();
  const result = await rpc.getBalance(address(addr)).send();
  return lamportsToSol(result.value);
}

export async function getTokenBalances(walletAddress: string): Promise<TokenBalance[]> {
  const rpc = getRpc();
  const balances: TokenBalance[] = [];

  // SOL balance
  const solBalance = await getSolBalance(walletAddress);
  balances.push({
    mint: SOL_MINT,
    symbol: 'SOL',
    name: 'Solana',
    decimals: SOL_DECIMALS,
    balance: String(BigInt(Math.round(solBalance * 1e9))),
    uiBalance: solBalance,
  });

  // SPL token accounts
  try {
    const tokenAccounts = await rpc.getTokenAccountsByOwner(
      address(walletAddress),
      { programId: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
      { encoding: 'jsonParsed' }
    ).send();

    for (const account of tokenAccounts.value) {
      const parsed = (account.account.data as any).parsed?.info;
      if (!parsed) continue;

      const mint = parsed.mint as string;
      const rawBalance = parsed.tokenAmount?.amount as string;
      const decimals = parsed.tokenAmount?.decimals as number;
      const uiBalance = parsed.tokenAmount?.uiAmount as number;

      if (!rawBalance || rawBalance === '0') continue;

      // Resolve token metadata
      let symbol = mint;
      let name = 'Unknown Token';
      try {
        const meta = await resolveToken(mint);
        if (meta) {
          symbol = meta.symbol;
          name = meta.name;
        }
      } catch {
        verbose(`Could not resolve metadata for ${mint}`);
      }

      balances.push({ mint, symbol, name, decimals, balance: rawBalance, uiBalance });
    }
  } catch (err) {
    verbose(`Failed to fetch token accounts: ${err}`);
  }

  return balances;
}

// ── Token account info (includes zero-balance, includes account pubkeys) ──

export interface TokenAccountInfo {
  pubkey: string;        // token account address
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;       // raw amount string
  uiBalance: number;
}

export async function getAllTokenAccounts(walletAddress: string): Promise<TokenAccountInfo[]> {
  const rpc = getRpc();
  const accounts: TokenAccountInfo[] = [];

  try {
    const tokenAccounts = await rpc.getTokenAccountsByOwner(
      address(walletAddress),
      { programId: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
      { encoding: 'jsonParsed' }
    ).send();

    for (const account of tokenAccounts.value) {
      const parsed = (account.account.data as any).parsed?.info;
      if (!parsed) continue;

      const mint = parsed.mint as string;
      const rawBalance = parsed.tokenAmount?.amount as string ?? '0';
      const decimals = parsed.tokenAmount?.decimals as number ?? 0;
      const uiBalance = parsed.tokenAmount?.uiAmount as number ?? 0;
      const pubkey = String(account.pubkey);

      let symbol = mint;
      let name = 'Unknown Token';
      try {
        const meta = await resolveToken(mint);
        if (meta) {
          symbol = meta.symbol;
          name = meta.name;
        }
      } catch {
        verbose(`Could not resolve metadata for ${mint}`);
      }

      accounts.push({ pubkey, mint, symbol, name, decimals, balance: rawBalance, uiBalance });
    }
  } catch (err) {
    verbose(`Failed to fetch token accounts: ${err}`);
  }

  return accounts;
}
