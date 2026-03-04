import { address } from '@solana/kit';
import { lamportsToSol, tokenAmountToUi, SOL_MINT, SOL_DECIMALS } from '../utils/solana.js';
import type { SolContext } from '../types.js';
import type { TokenRegistryService } from './token-registry-service.js';

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  uiBalance: number;
}

export interface TokenAccountInfo {
  pubkey: string;
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  uiBalance: number;
}

export interface TokenService {
  getSolBalance(addr: string): Promise<number>;
  getTokenBalances(walletAddress: string): Promise<TokenBalance[]>;
  getAllTokenAccounts(walletAddress: string): Promise<TokenAccountInfo[]>;
}

export function createTokenService(ctx: SolContext, registry: TokenRegistryService): TokenService {
  const { rpc, logger } = ctx;

  async function getSolBalance(addr: string): Promise<number> {
    const result = await rpc.getBalance(address(addr)).send();
    return lamportsToSol(result.value);
  }

  async function getTokenBalances(walletAddress: string): Promise<TokenBalance[]> {
    const balances: TokenBalance[] = [];

    const solBalance = await getSolBalance(walletAddress);
    balances.push({
      mint: SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      decimals: SOL_DECIMALS,
      balance: String(BigInt(Math.round(solBalance * 1e9))),
      uiBalance: solBalance,
    });

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

        let symbol = mint;
        let name = 'Unknown Token';
        try {
          const meta = await registry.resolveToken(mint);
          if (meta) {
            symbol = meta.symbol;
            name = meta.name;
          }
        } catch {
          logger.verbose(`Could not resolve metadata for ${mint}`);
        }

        balances.push({ mint, symbol, name, decimals, balance: rawBalance, uiBalance });
      }
    } catch (err) {
      logger.verbose(`Failed to fetch token accounts: ${err}`);
    }

    return balances;
  }

  async function getAllTokenAccounts(walletAddress: string): Promise<TokenAccountInfo[]> {
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
          const meta = await registry.resolveToken(mint);
          if (meta) {
            symbol = meta.symbol;
            name = meta.name;
          }
        } catch {
          logger.verbose(`Could not resolve metadata for ${mint}`);
        }

        accounts.push({ pubkey, mint, symbol, name, decimals, balance: rawBalance, uiBalance });
      }
    } catch (err) {
      logger.verbose(`Failed to fetch token accounts: ${err}`);
    }

    return accounts;
  }

  return { getSolBalance, getTokenBalances, getAllTokenAccounts };
}
