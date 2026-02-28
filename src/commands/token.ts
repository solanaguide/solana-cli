import { Command } from 'commander';
import { getSdk } from '../sdk-init.js';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { output, success, failure, isJsonMode, timed, verbose, fmtPrice } from '../output/formatter.js';
import { table } from '../output/table.js';
import { isValidAddress, solToLamports, uiToTokenAmount, explorerUrl, SOL_MINT } from '../utils/solana.js';
import { isPermitted } from '../core/config-manager.js';
import { assertWithinLimits, assertAllowedRecipient, assertAllowedToken } from '../core/security.js';
import { address, type Instruction } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getBurnCheckedInstruction, getCloseAccountInstruction } from '@solana-program/token';
import * as walletRepo from '../db/repos/wallet-repo.js';
import { registerOrderCommands } from './token-orders.js';
import type { TokenAccountInfo } from '@solana-compass/sdk';

export function registerTokenCommand(program: Command): void {
  const token = program.command('token').description('Token operations');

  token
    .command('price <symbols...>')
    .description('Get current USD price for one or more tokens')
    .action(async (symbols: string[]) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const sdk = getSdk();
          const resolved = await sdk.registry.resolveTokens(symbols);
          const mints = [...resolved.values()].map(t => t.mint);
          const prices = await sdk.price.getPrices(mints);

          return symbols.map(sym => {
            const token = resolved.get(sym);
            if (!token) return { symbol: sym, mint: null, priceUsd: null, error: 'Unknown token' };
            const price = prices.get(token.mint);
            return {
              symbol: token.symbol,
              name: token.name,
              mint: token.mint,
              priceUsd: price?.priceUsd ?? null,
            };
          });
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          for (const p of data) {
            if (p.priceUsd !== null) {
              console.log(`${p.symbol}: $${p.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
            } else {
              console.log(`${p.symbol}: ${p.error || 'price unavailable'}`);
            }
          }
        }
      } catch (err: any) {
        output(failure('PRICE_FETCH_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('info <symbol>')
    .description('Show token metadata (decimals, supply, authorities)')
    .action(async (symbol: string) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const token = await getSdk().registry.resolveToken(symbol);
          if (!token) throw new Error(`Unknown token: ${symbol}`);
          return token;
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`${data.symbol} — ${data.name}`);
          console.log(`  Mint:     ${data.mint}`);
          console.log(`  Decimals: ${data.decimals}`);
          if (data.logoUri) console.log(`  Logo:     ${data.logoUri}`);
        }
      } catch (err: any) {
        output(failure('TOKEN_INFO_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('list')
    .description('List all tokens in wallet')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (opts: any) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName)!;

        const { result: balances, elapsed_ms } = await timed(() => getSdk().token.getTokenBalances(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, tokens: balances }, { elapsed_ms }));
        } else {
          console.log(`Tokens in wallet "${walletName}":\n`);
          if (balances.length === 0) {
            console.log('  No tokens found.');
          } else {
            console.log(table(
              balances.map(b => ({
                symbol: b.symbol,
                balance: b.uiBalance.toFixed(6),
                mint: b.mint.length > 20 ? b.mint.slice(0, 8) + '...' + b.mint.slice(-4) : b.mint,
              })),
              [
                { key: 'symbol', header: 'Token' },
                { key: 'balance', header: 'Balance', align: 'right' },
                { key: 'mint', header: 'Mint' },
              ]
            ));
          }
        }
      } catch (err: any) {
        output(failure('TOKEN_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('sync')
    .description('Refresh token metadata cache from Jupiter')
    .action(async () => {
      try {
        const { result: count, elapsed_ms } = await timed(() => getSdk().registry.syncTokenCache());

        if (isJsonMode()) {
          output(success({ tokensCached: count }, { elapsed_ms }));
        } else {
          console.log(`Synced ${count} tokens to cache.`);
        }
      } catch (err: any) {
        output(failure('TOKEN_SYNC_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── Browse ──────────────────────────────────────────────────

  token
    .command('browse [category]')
    .description('Browse token lists — trending, top-traded, recent, and more')
    .option('--interval <interval>', 'Time interval: 5m, 1h, 6h, 24h', '1h')
    .option('--limit <n>', 'Number of results', parseInt, 20)
    .action(async (category: string | undefined, opts) => {
      try {
        if (!category) {
          // List available categories
          const categories = getSdk().lists.getCategories();
          if (isJsonMode()) {
            output(success(categories));
          } else {
            console.log('Available categories:\n');
            for (const cat of categories) {
              const interval = cat.supportsInterval ? ' (supports --interval)' : '';
              console.log(`  ${cat.id.padEnd(14)} ${cat.description}${interval}`);
            }
            console.log('\nUsage: sol token browse <category> [--interval 1h] [--limit 20]');
          }
          return;
        }

        const { result: entries, elapsed_ms } = await timed(() =>
          getSdk().lists.browseTokens(category, { interval: opts.interval, limit: opts.limit })
        );

        if (isJsonMode()) {
          output(success(entries, { elapsed_ms }));
        } else {
          console.log(`${category} tokens${opts.interval !== '1h' ? ` (${opts.interval})` : ''}:\n`);
          if (entries.length === 0) {
            console.log('  No results.');
          } else {
            console.log(table(
              entries.map((e, i) => ({
                rank: String(i + 1),
                symbol: e.symbol || '???',
                name: e.name.length > 24 ? e.name.slice(0, 22) + '..' : e.name,
                price: e.priceUsd != null ? `$${fmtPrice(e.priceUsd)}` : '—',
                change24h: e.change24hPct != null ? `${e.change24hPct >= 0 ? '+' : ''}${e.change24hPct.toFixed(1)}%` : '—',
                volume: e.volume24hUsd != null ? fmtVolume(e.volume24hUsd) : '—',
              })),
              [
                { key: 'rank', header: '#', align: 'right' },
                { key: 'symbol', header: 'Symbol' },
                { key: 'name', header: 'Name' },
                { key: 'price', header: 'Price', align: 'right' },
                { key: 'change24h', header: '24h', align: 'right' },
                { key: 'volume', header: 'Volume 24h', align: 'right' },
              ]
            ));
          }
          console.log(`\nRun \`sol token info <symbol>\` for details, or \`sol token swap <amount> <from> <to>\` to trade.`);
        }
      } catch (err: any) {
        output(failure('TOKEN_BROWSE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canSwap')) token
    .command('swap <amount> <from> <to>')
    .description('Swap tokens (e.g., sol token swap 1.5 SOL USDC)')
    .option('--slippage <bps>', 'Slippage tolerance in basis points', parseInt)
    .option('--router <name>', 'Router to use: best, jupiter, dflow (default: best)')
    .option('--quote-only', 'Show quote without executing')
    .option('--wallet <name>', 'Wallet to use')
    .option('--yes', 'Skip confirmation')
    .action(async (amountStr: string, from: string, to: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const sdk = getSdk();

        // Token allowlist check
        const resolved = await sdk.registry.resolveTokens([from, to]);
        const resolvedMints = new Map<string, string>();
        for (const [sym, tok] of resolved) resolvedMints.set(sym.toUpperCase(), tok.mint);
        const fromToken = resolved.get(from);
        const toToken = resolved.get(to);
        if (fromToken) assertAllowedToken(fromToken.mint, fromToken.symbol, resolvedMints);
        if (toToken) assertAllowedToken(toToken.mint, toToken.symbol, resolvedMints);

        // Transaction limits check (USD value of input)
        if (fromToken && !opts.quoteOnly) {
          const prices = await sdk.price.getPrices([fromToken.mint]);
          const price = prices.get(fromToken.mint);
          if (price) assertWithinLimits(amount * price.priceUsd);
        }

        const { result: quote, elapsed_ms } = await timed(() =>
          sdk.swap.getQuote(from, to, amount, { slippageBps: opts.slippage, router: opts.router })
        );

        if (opts.quoteOnly) {
          if (isJsonMode()) {
            const { _raw, _routerName, ...quoteData } = quote;
            output(success(quoteData, { elapsed_ms }));
          } else {
            console.log(`Swap Quote:`);
            console.log(`  ${quote.inputUiAmount} ${quote.inputSymbol} → ${quote.outputUiAmount.toFixed(6)} ${quote.outputSymbol}`);
            console.log(`  Price impact: ${quote.priceImpactPct.toFixed(4)}%`);
            console.log(`  Route: ${quote.routePlan} (via ${quote.routerName})`);
            console.log(`  Slippage: ${quote.slippageBps / 100}%`);
          }
          return;
        }

        // Show quote before executing (unless --yes)
        if (!opts.yes && !isJsonMode()) {
          console.log(`Swap: ${quote.inputUiAmount} ${quote.inputSymbol} → ${quote.outputUiAmount.toFixed(6)} ${quote.outputSymbol}`);
          console.log(`  Price impact: ${quote.priceImpactPct.toFixed(4)}%`);
          console.log(`  Route: ${quote.routePlan} (via ${quote.routerName})`);
        }

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const result = await sdk.swap.executeSwap(from, to, amount, walletName, { slippageBps: opts.slippage, router: opts.router });

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`\nSwap executed!`);
          console.log(`  ${result.inputAmount} ${result.inputSymbol} → ${result.outputAmount.toFixed(6)} ${result.outputSymbol}`);
          console.log(`  Signature: ${result.signature}`);
          console.log(`  Explorer: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('SWAP_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canTransfer')) token
    .command('send <amount> <tokenSymbol> <recipient>')
    .description('Send SOL or SPL tokens to an address')
    .option('--wallet <name>', 'Wallet to send from')
    .option('--yes', 'Skip confirmation')
    .action(async (amountStr: string, tokenSymbol: string, recipient: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
        if (!isValidAddress(recipient)) throw new Error('Invalid recipient address');

        // Address allowlist check
        assertAllowedRecipient(recipient);

        const sdk = getSdk();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const signer = await sdk.ctx.signer.getSigner(walletName);

        const tokenMeta = await sdk.registry.resolveToken(tokenSymbol);
        if (!tokenMeta) throw new Error(`Unknown token: ${tokenSymbol}`);

        // Transaction limits check
        const prices = await sdk.price.getPrices([tokenMeta.mint]);
        const price = prices.get(tokenMeta.mint);
        if (price) assertWithinLimits(amount * price.priceUsd);

        if (!opts.yes && !isJsonMode()) {
          console.log(`Send ${amount} ${tokenMeta.symbol} from "${walletName}" to ${recipient}`);
        }

        if (tokenMeta.mint === SOL_MINT) {
          const ix = getTransferSolInstruction({
            source: signer,
            destination: address(recipient),
            amount: solToLamports(amount),
          });

          const result = await sdk.tx.buildAndSendTransaction([ix], signer, {
            txType: 'transfer',
            walletName,
            fromMint: SOL_MINT,
            fromAmount: String(solToLamports(amount)),
          });

          if (isJsonMode()) {
            output(success({
              signature: result.signature,
              from: signer.address,
              to: recipient,
              amount,
              token: tokenMeta.symbol,
              status: result.status,
              explorerUrl: result.explorerUrl,
            }));
          } else {
            console.log(`\nSent ${amount} SOL`);
            console.log(`  Signature: ${result.signature}`);
            console.log(`  Explorer: ${result.explorerUrl}`);
          }
        } else {
          // SPL token transfer — requires token program instructions
          // TODO: Implement SPL token transfer using @solana-program/token
          throw new Error('SPL token transfers coming soon. Use SOL transfers for now.');
        }
      } catch (err: any) {
        output(failure('SEND_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── Burn ────────────────────────────────────────────────────

  if (isPermitted('canBurn')) token
    .command('burn <symbol> [amount]')
    .description('Burn tokens from wallet')
    .option('--all', 'Burn entire balance')
    .option('--close', 'Close the token account after burning')
    .option('--wallet <name>', 'Wallet to use')
    .option('--yes', 'Skip confirmation')
    .action(async (symbol: string, amountStr: string | undefined, opts) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const sdk = getSdk();
          const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
          const signer = await sdk.ctx.signer.getSigner(walletName);
          const wallet = walletRepo.getWallet(walletName);
          if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

          const tokenMeta = await sdk.registry.resolveToken(symbol);
          if (!tokenMeta) throw new Error(`Unknown token: ${symbol}`);
          if (tokenMeta.mint === SOL_MINT) throw new Error('Cannot burn native SOL');

          // Find the token account
          const accounts = await sdk.token.getAllTokenAccounts(wallet.address);
          const tokenAccount = accounts.find(a => a.mint === tokenMeta.mint);
          if (!tokenAccount) throw new Error(`No token account found for ${tokenMeta.symbol}`);

          let burnAmount: bigint;
          if (opts.all) {
            burnAmount = BigInt(tokenAccount.balance);
            if (burnAmount === 0n) throw new Error(`Token account for ${tokenMeta.symbol} has zero balance`);
          } else if (amountStr) {
            const amount = parseFloat(amountStr);
            if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
            burnAmount = uiToTokenAmount(amount, tokenMeta.decimals);
            if (burnAmount > BigInt(tokenAccount.balance)) {
              throw new Error(`Insufficient balance: have ${tokenAccount.uiBalance}, want to burn ${amount}`);
            }
          } else {
            throw new Error('Specify an amount or use --all');
          }

          const uiBurnAmount = Number(burnAmount) / Math.pow(10, tokenMeta.decimals);

          if (!opts.yes && !isJsonMode()) {
            console.log(`Burn ${uiBurnAmount} ${tokenMeta.symbol} from "${walletName}"`);
            if (opts.close) console.log('  + close token account (reclaim rent)');
          }

          const instructions: Instruction[] = [
            getBurnCheckedInstruction({
              account: address(tokenAccount.pubkey),
              mint: address(tokenMeta.mint),
              authority: signer,
              amount: burnAmount,
              decimals: tokenMeta.decimals,
            }),
          ];

          // Close account if requested and entire balance is being burned
          const shouldClose = opts.close && (opts.all || burnAmount === BigInt(tokenAccount.balance));
          if (shouldClose) {
            instructions.push(
              getCloseAccountInstruction({
                account: address(tokenAccount.pubkey),
                destination: address(wallet.address),
                owner: signer,
              }),
            );
          }

          const result = await sdk.tx.buildAndSendTransaction(instructions, signer, {
            txType: 'burn',
            walletName,
            fromMint: tokenMeta.mint,
            fromAmount: String(burnAmount),
          });

          return {
            signature: result.signature,
            token: tokenMeta.symbol,
            mint: tokenMeta.mint,
            amountBurned: uiBurnAmount,
            accountClosed: shouldClose,
            status: result.status,
            explorerUrl: result.explorerUrl,
          };
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`\nBurned ${data.amountBurned} ${data.token}`);
          if (data.accountClosed) console.log('  Account closed (rent reclaimed)');
          console.log(`  Signature: ${data.signature}`);
          console.log(`  Explorer: ${data.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('BURN_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── Close ───────────────────────────────────────────────────

  token
    .command('close [symbol]')
    .description('Close token accounts to reclaim rent SOL (~0.002 SOL each)')
    .option('--burn', 'Burn remaining dust tokens before closing')
    .option('--all', 'Close everything: swap valuable tokens to SOL, burn dust, close')
    .option('--wallet <name>', 'Wallet to use')
    .option('--yes', 'Skip confirmation')
    .action(async (symbol: string | undefined, opts) => {
      try {
        if (opts.all && !isPermitted('canSwap')) throw new Error('Permission denied: canSwap is disabled');
        if (opts.burn && !isPermitted('canBurn')) throw new Error('Permission denied: canBurn is disabled');

        const { result: data, elapsed_ms } = await timed(async () => {
          const sdk = getSdk();
          const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
          const signer = await sdk.ctx.signer.getSigner(walletName);
          const wallet = walletRepo.getWallet(walletName);
          if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

          const accounts = await sdk.token.getAllTokenAccounts(wallet.address);

          // If specific token, filter to just that one
          let targets: TokenAccountInfo[];
          if (symbol) {
            const tokenMeta = await sdk.registry.resolveToken(symbol);
            if (!tokenMeta) throw new Error(`Unknown token: ${symbol}`);
            targets = accounts.filter(a => a.mint === tokenMeta.mint);
            if (targets.length === 0) throw new Error(`No token account found for ${symbol}`);
          } else {
            targets = accounts;
          }

          if (targets.length === 0) throw new Error('No token accounts to close');

          // Classify accounts
          const empty: TokenAccountInfo[] = [];
          const hasDust: TokenAccountInfo[] = [];
          const hasValue: TokenAccountInfo[] = [];

          const DUST_THRESHOLD_USD = 0.0001;

          // Get prices for non-zero accounts
          const nonZeroMints = targets.filter(a => a.balance !== '0').map(a => a.mint);
          const prices = nonZeroMints.length > 0 ? await sdk.price.getPrices(nonZeroMints) : new Map();

          for (const account of targets) {
            if (account.balance === '0') {
              empty.push(account);
              continue;
            }

            const price = prices.get(account.mint);
            const valueUsd = price ? price.priceUsd * account.uiBalance : null;

            if (valueUsd === null || valueUsd < DUST_THRESHOLD_USD) {
              hasDust.push(account);
            } else {
              hasValue.push(account);
            }
          }

          if (!isJsonMode()) {
            if (empty.length > 0) console.log(`  ${empty.length} empty account(s) — will close`);
            if (hasDust.length > 0) console.log(`  ${hasDust.length} dust account(s) (< $0.0001)${opts.burn || opts.all ? ' — will burn + close' : ' — use --burn to burn + close'}`);
            if (hasValue.length > 0) console.log(`  ${hasValue.length} account(s) with value${opts.all ? ' — will swap to SOL + close' : ' — use --all to swap + close'}`);
          }

          const results: Array<{
            account: string;
            mint: string;
            symbol: string;
            action: string;
            signature?: string;
            explorerUrl?: string;
          }> = [];

          // 1. Handle --all: swap valuable tokens to SOL first
          if (opts.all && hasValue.length > 0) {
            for (const account of hasValue) {
              if (account.mint === SOL_MINT) continue;
              try {
                if (!isJsonMode()) console.log(`  Swapping ${account.uiBalance} ${account.symbol} to SOL...`);
                const swapResult = await sdk.swap.executeSwap(
                  account.symbol, 'SOL', account.uiBalance, walletName,
                  { rewardBps: 500 }
                );
                results.push({
                  account: account.pubkey,
                  mint: account.mint,
                  symbol: account.symbol,
                  action: 'swapped',
                  signature: swapResult.signature,
                  explorerUrl: swapResult.explorerUrl,
                });
                // After swap the account may now be empty — add to close list
                empty.push(account);
              } catch (err: any) {
                verbose(`Failed to swap ${account.symbol}: ${err.message}`);
                results.push({
                  account: account.pubkey,
                  mint: account.mint,
                  symbol: account.symbol,
                  action: `swap failed: ${err.message}`,
                });
              }
            }
          }

          // 2. Burn dust + close, or just close empty
          const toProcess = [
            ...empty.map(a => ({ ...a, needsBurn: false })),
            ...(opts.burn || opts.all ? hasDust.map(a => ({ ...a, needsBurn: true })) : []),
          ];

          // Batch into transactions (max ~20 accounts per tx to stay under compute limits)
          const BATCH_SIZE = 20;
          for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
            const batch = toProcess.slice(i, i + BATCH_SIZE);
            const instructions: Instruction[] = [];

            for (const account of batch) {
              if (account.needsBurn && account.balance !== '0') {
                instructions.push(
                  getBurnCheckedInstruction({
                    account: address(account.pubkey),
                    mint: address(account.mint),
                    authority: signer,
                    amount: BigInt(account.balance),
                    decimals: account.decimals,
                  }),
                );
              }

              instructions.push(
                getCloseAccountInstruction({
                  account: address(account.pubkey),
                  destination: address(wallet.address),
                  owner: signer,
                }),
              );
            }

            if (instructions.length === 0) continue;

            // 5% of reclaimed rent to compassSOL reserve
            const RENT_PER_ACCOUNT = 2_039_280n;
            const contributionPerAccount = RENT_PER_ACCOUNT * 5n / 100n;
            const totalContribution = contributionPerAccount * BigInt(batch.length);
            instructions.push(
              getTransferSolInstruction({
                source: signer,
                destination: address('8H2xjMT543YWBLRjJ24BrQyBgFuQRU6MgENA3mqXoh7y'),
                amount: totalContribution,
              }),
            );

            try {
              const txResult = await sdk.tx.buildAndSendTransaction(instructions, signer, {
                txType: 'close',
                walletName,
              });

              for (const account of batch) {
                results.push({
                  account: account.pubkey,
                  mint: account.mint,
                  symbol: account.symbol,
                  action: account.needsBurn ? 'burned + closed' : 'closed',
                  signature: txResult.signature,
                  explorerUrl: txResult.explorerUrl,
                });
              }
            } catch (err: any) {
              for (const account of batch) {
                results.push({
                  account: account.pubkey,
                  mint: account.mint,
                  symbol: account.symbol,
                  action: `failed: ${err.message}`,
                });
              }
            }
          }

          // Accounts that weren't processed (have value but no --all, dust but no --burn)
          const skippedValue = opts.all ? [] : hasValue;
          const skippedDust = (opts.burn || opts.all) ? [] : hasDust;

          return {
            closed: results.filter(r => r.action.includes('closed')).length,
            burned: results.filter(r => r.action.includes('burned')).length,
            swapped: results.filter(r => r.action === 'swapped').length,
            failed: results.filter(r => r.action.includes('failed')).length,
            skippedWithValue: skippedValue.length,
            skippedWithDust: skippedDust.length,
            rentReclaimed: results.filter(r => r.action.includes('closed')).length * 0.00203,
            accounts: results,
          };
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`\nClosed ${data.closed} account(s)`);
          if (data.burned > 0) console.log(`  Burned dust in ${data.burned} account(s)`);
          if (data.swapped > 0) console.log(`  Swapped ${data.swapped} token(s) to SOL`);
          if (data.failed > 0) console.log(`  Failed: ${data.failed}`);
          if (data.rentReclaimed > 0) console.log(`  Rent reclaimed: ~${data.rentReclaimed.toFixed(5)} SOL`);
          if (data.skippedWithValue > 0) console.log(`  Skipped ${data.skippedWithValue} account(s) with value (use --all)`);
          if (data.skippedWithDust > 0) console.log(`  Skipped ${data.skippedWithDust} dust account(s) (use --burn)`);
          if (data.accounts.length > 0) {
            const sigs = [...new Set(data.accounts.filter(a => a.signature).map(a => a.signature))];
            for (const sig of sigs) {
              console.log(`  Tx: ${explorerUrl(sig!)}`);
            }
          }
          console.log('');
        }
      } catch (err: any) {
        output(failure('CLOSE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── DCA & Limit Orders ──────────────────────────────────────
  registerOrderCommands(token);
}

function fmtVolume(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
