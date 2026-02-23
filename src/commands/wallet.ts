import { Command } from 'commander';
import * as walletManager from '../core/wallet-manager.js';
import { getSolBalance, getTokenBalances } from '../core/token-service.js';
import { getPrices } from '../core/price-service.js';
import { getOnrampUrl } from '../core/onramp-service.js';
import { output, success, failure, isJsonMode, timed, fmtPrice } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';
import * as txRepo from '../db/repos/transaction-repo.js';
import { getWellKnownByMint } from '../utils/token-list.js';
import { getTokenByMint } from '../db/repos/token-repo.js';
import { shortenAddress, tokenAmountToUi, SOL_MINT } from '../utils/solana.js';

export function registerWalletCommand(program: Command): void {
  const wallet = program.command('wallet').description('Wallet management');

  wallet
    .command('create')
    .description('Create a new wallet')
    .option('--name <name>', 'Wallet name')
    .option('--count <n>', 'Batch create multiple wallets', parseInt)
    .action(async (opts) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          if (opts.count && opts.count > 1) {
            const baseName = opts.name || 'wallet';
            return walletManager.createBatch(baseName, opts.count);
          } else {
            const name = opts.name || `wallet-${walletRepo.walletCount() + 1}`;
            return walletManager.createWallet(name);
          }
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          if (Array.isArray(data)) {
            console.log(`Created ${data.length} wallets:`);
            for (const w of data) {
              console.log(`  ${w.name}: ${w.address}`);
            }
          } else {
            console.log(`Created wallet "${data.name}"`);
            console.log(`  Address: ${data.address}`);
          }
        }
      } catch (err: any) {
        output(failure('WALLET_CREATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('list')
    .description('List all wallets')
    .option('--label <label>', 'Filter by label')
    .action(async (opts) => {
      try {
        const wallets = walletManager.listWallets(opts.label);

        if (wallets.length === 0) {
          if (isJsonMode()) {
            output(success([]));
          } else {
            console.log('No wallets found. Create one with: sol wallet create');
          }
          return;
        }

        // Fetch SOL balances in parallel
        const balances = await Promise.all(
          wallets.map(w => getSolBalance(w.address).catch(() => null))
        );

        if (isJsonMode()) {
          output(success(wallets.map((w, i) => ({
            ...w,
            solBalance: balances[i],
          }))));
        } else {
          console.log(table(
            wallets.map((w, i) => ({
              name: w.name,
              address: w.address,
              sol: balances[i] !== null ? `${balances[i]!.toFixed(4)} SOL` : '—',
              labels: w.labels.join(', ') || '—',
            })),
            [
              { key: 'name', header: 'Name' },
              { key: 'address', header: 'Address' },
              { key: 'sol', header: 'SOL', align: 'right' },
              { key: 'labels', header: 'Labels' },
            ]
          ));
          console.log('\nRun `sol wallet balance` for full token balances and USD values.');
        }
      } catch (err: any) {
        output(failure('WALLET_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('balance [name]')
    .description('Show wallet balance (all tokens + USD value)')
    .action(async (name?: string) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const walletName = name || walletManager.getDefaultWalletName();
          const wallet = walletRepo.getWallet(walletName);
          if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

          const balances = await getTokenBalances(wallet.address);

          // Get USD prices for all tokens
          const mints = balances.map(b => b.mint);
          const prices = await getPrices(mints);

          return {
            wallet: walletName,
            address: wallet.address,
            tokens: balances.map(b => {
              const price = prices.get(b.mint);
              return {
                symbol: b.symbol,
                balance: b.uiBalance,
                priceUsd: price?.priceUsd ?? null,
                valueUsd: price ? b.uiBalance * price.priceUsd : null,
              };
            }),
            totalValueUsd: balances.reduce((sum, b) => {
              const price = prices.get(b.mint);
              return sum + (price ? b.uiBalance * price.priceUsd : 0);
            }, 0),
          };
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`Wallet: ${data.wallet} (${data.address})\n`);
          console.log(table(
            data.tokens.map(t => ({
              symbol: t.symbol,
              balance: t.balance.toFixed(6),
              price: t.priceUsd !== null ? `$${fmtPrice(t.priceUsd)}` : '—',
              value: t.valueUsd !== null ? `$${t.valueUsd.toFixed(2)}` : '—',
            })),
            [
              { key: 'symbol', header: 'Token' },
              { key: 'balance', header: 'Balance', align: 'right' },
              { key: 'price', header: 'Price', align: 'right' },
              { key: 'value', header: 'Value', align: 'right' },
            ]
          ));
          console.log(`\nTotal: $${data.totalValueUsd.toFixed(2)}`);
        }
      } catch (err: any) {
        output(failure('BALANCE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('import <path>')
    .description('Import wallet from keypair file')
    .option('--name <name>', 'Wallet name')
    .option('--solana-cli', 'Import from Solana CLI default keypair')
    .action(async (filePath: string, opts) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          if (opts.solanaCli) {
            return walletManager.importFromSolanaCli(opts.name);
          }
          const name = opts.name || `imported-${walletRepo.walletCount() + 1}`;
          return walletManager.importFromFile(filePath, name);
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`Imported wallet "${data.name}"`);
          console.log(`  Address: ${data.address}`);
        }
      } catch (err: any) {
        output(failure('WALLET_IMPORT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('export <name>')
    .description('Show path to wallet key file')
    .action((name: string) => {
      try {
        const filePath = walletManager.getWalletFilePath(name);
        if (isJsonMode()) {
          output(success({ name, filePath }));
        } else {
          console.log(filePath);
        }
      } catch (err: any) {
        output(failure('WALLET_EXPORT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('remove <name>')
    .description('Remove a wallet')
    .option('--delete', 'Also delete the key file')
    .action((name: string, opts) => {
      try {
        walletManager.removeWallet(name, opts.delete || false);
        if (isJsonMode()) {
          output(success({ name, deleted: opts.delete || false }));
        } else {
          console.log(`Removed wallet "${name}"${opts.delete ? ' (key file deleted)' : ''}`);
        }
      } catch (err: any) {
        output(failure('WALLET_REMOVE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('label <name>')
    .description('Add or remove labels from a wallet')
    .option('--add <label>', 'Add a label')
    .option('--remove <label>', 'Remove a label')
    .action((name: string, opts) => {
      try {
        if (opts.add) {
          walletManager.addLabel(name, opts.add);
          if (isJsonMode()) {
            output(success({ name, action: 'add', label: opts.add }));
          } else {
            console.log(`Added label "${opts.add}" to wallet "${name}"`);
          }
        } else if (opts.remove) {
          walletManager.removeLabel(name, opts.remove);
          if (isJsonMode()) {
            output(success({ name, action: 'remove', label: opts.remove }));
          } else {
            console.log(`Removed label "${opts.remove}" from wallet "${name}"`);
          }
        } else {
          const labels = walletRepo.getLabels(name);
          if (isJsonMode()) {
            output(success({ name, labels }));
          } else if (labels.length === 0) {
            console.log(`Wallet "${name}" has no labels`);
          } else {
            console.log(`Labels for "${name}": ${labels.join(', ')}`);
          }
        }
      } catch (err: any) {
        output(failure('WALLET_LABEL_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('fund [name]')
    .description('Generate fiat onramp payment URL')
    .option('--amount <usd>', 'Prefill USD amount', parseFloat)
    .option('--provider <name>', 'Onramp provider (transak, sphere)')
    .action(async (name?: string, opts?: any) => {
      try {
        const walletName = name || walletManager.getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const url = getOnrampUrl({
          walletAddress: wallet.address,
          amount: opts?.amount,
          provider: opts?.provider,
        });

        if (isJsonMode()) {
          output(success({ wallet: walletName, address: wallet.address, url, provider: opts?.provider || 'transak' }));
        } else {
          console.log(`Fund wallet "${walletName}" (${wallet.address}):`);
          console.log(`\n  ${url}\n`);
          console.log('Open this URL in your browser to purchase SOL.');
        }
      } catch (err: any) {
        output(failure('WALLET_FUND_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  wallet
    .command('history [name]')
    .description('Show recent transaction activity')
    .option('--limit <n>', 'Number of transactions to show', parseInt, 20)
    .option('--type <type>', 'Filter by type (transfer, swap)')
    .action(async (name?: string, opts?: any) => {
      try {
        const walletName = name || walletManager.getDefaultWalletName();

        const txs = txRepo.getRecentTransactions({
          walletName,
          type: opts?.type,
          limit: opts?.limit,
        });

        if (isJsonMode()) {
          output(success({
            wallet: walletName,
            transactions: txs.map(tx => ({
              ...tx,
              fromSymbol: mintToSymbol(tx.from_mint),
              toSymbol: mintToSymbol(tx.to_mint),
              fromUiAmount: formatTxAmount(tx.from_mint, tx.from_amount),
              toUiAmount: formatTxAmount(tx.to_mint, tx.to_amount),
              explorerUrl: `https://solscan.io/tx/${tx.signature}`,
            })),
          }));
        } else if (txs.length === 0) {
          console.log(`No transactions found for wallet "${walletName}".`);
        } else {
          console.log(`Recent activity for "${walletName}":\n`);
          console.log(table(
            txs.map(tx => ({
              type: tx.type,
              detail: formatTxDetail(tx),
              status: tx.status,
              signature: shortenAddress(tx.signature, 6),
              date: tx.created_at,
            })),
            [
              { key: 'type', header: 'Type' },
              { key: 'detail', header: 'Detail' },
              { key: 'status', header: 'Status' },
              { key: 'signature', header: 'Signature' },
              { key: 'date', header: 'Date' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('WALLET_HISTORY_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

function mintToSymbol(mint: string | null): string | null {
  if (!mint) return null;
  const wellKnown = getWellKnownByMint(mint);
  if (wellKnown) return wellKnown.symbol;
  const cached = getTokenByMint(mint);
  if (cached?.symbol) return cached.symbol;
  return shortenAddress(mint, 4);
}

function mintDecimals(mint: string | null): number {
  if (!mint) return 0;
  const wellKnown = getWellKnownByMint(mint);
  if (wellKnown) return wellKnown.decimals;
  const cached = getTokenByMint(mint);
  if (cached) return cached.decimals;
  return 0;
}

function formatTxAmount(mint: string | null, rawAmount: string | null): string | null {
  if (!mint || !rawAmount) return null;
  const decimals = mintDecimals(mint);
  if (decimals === 0) return rawAmount;
  return tokenAmountToUi(rawAmount, decimals).toFixed(6);
}

function formatTxDetail(tx: txRepo.TransactionRow): string {
  const fromSym = mintToSymbol(tx.from_mint);
  const toSym = mintToSymbol(tx.to_mint);
  const fromAmt = formatTxAmount(tx.from_mint, tx.from_amount);
  const toAmt = formatTxAmount(tx.to_mint, tx.to_amount);

  if (tx.type === 'swap' && fromSym && toSym && fromAmt && toAmt) {
    return `${fromAmt} ${fromSym} → ${toAmt} ${toSym}`;
  }
  if (tx.type === 'transfer' && fromSym && fromAmt) {
    return `${fromAmt} ${fromSym}`;
  }
  if (fromAmt && fromSym) return `${fromAmt} ${fromSym}`;
  return '—';
}
