import { Command } from 'commander';
import { ensureProviders } from '../sdk-init.js';
import { EARN_PROTOCOL_NAMES } from '@solana-compass/sdk';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { isPermitted } from '../core/config-manager.js';
import { assertWithinLimitsFromPrice } from '../core/security.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerEarnCommand(program: Command): void {
  const earn = program.command('earn').description('Managed yield vaults (Kamino Earn, Loopscale)');

  const protocolOption = `--protocol <name>`;
  const protocolDesc = `Protocol to use (${EARN_PROTOCOL_NAMES.join(', ')})`;

  // ── list (default action) ──────────────────────────────

  earn
    .command('list [tokens...]', { isDefault: true })
    .description('List yield vaults with APY and TVL')
    .option(protocolOption, protocolDesc)
    .option('--sort <field>', 'Sort by: apy (default), tvl', 'apy')
    .action(async (tokens: string[], opts) => {
      try {
        const sdk = await ensureProviders();
        const filterTokens = tokens.length > 0 ? tokens : undefined;
        const sort = opts.sort === 'tvl' ? 'tvl' : 'apy' as const;
        const { result, elapsed_ms } = await timed(() =>
          sdk.earn.getVaults(filterTokens, opts.protocol, sort)
        );

        if (isJsonMode()) {
          output(success({
            tokens: filterTokens ?? 'all',
            protocol: opts.protocol ?? 'all',
            vaults: result.vaults,
            warnings: result.warnings,
            bestApyVault: result.bestApyVault,
          }, { elapsed_ms }));
        } else if (result.vaults.length === 0) {
          const label = filterTokens ? filterTokens.join(', ') : 'any tokens';
          console.log(`No earn vaults found for ${label}.`);
        } else {
          const protoLabel = opts.protocol ? ` — ${opts.protocol}` : '';
          const tokenLabel = filterTokens ? ' — ' + filterTokens.join(', ') : '';
          console.log(`Earn Vaults${protoLabel}${tokenLabel}\n`);

          console.log(table(
            result.vaults.map(v => {
              const isBest = result.bestApyVault[v.token] === v.vaultId;
              return {
                protocol: v.protocol,
                vault: v.vaultName,
                token: v.token,
                apy: `${(v.apy * 100).toFixed(2)}%${isBest ? ' *' : ''}`,
                tvl: fmtLargeAmount(v.tvlToken) + ' ' + v.token,
                tvlUsd: v.tvlUsd != null ? `$${fmtLargeAmount(v.tvlUsd)}` : '—',
              };
            }),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'vault', header: 'Vault' },
              { key: 'token', header: 'Token' },
              { key: 'apy', header: 'APY', align: 'right' },
              { key: 'tvl', header: 'TVL', align: 'right' },
              { key: 'tvlUsd', header: 'TVL (USD)', align: 'right' },
            ],
          ));

          if (result.warnings.length > 0) {
            console.log('');
            for (const w of result.warnings) {
              console.log(`  Warning: ${w}`);
            }
          }

          console.log(`\n* = best APY. Run \`sol earn deposit <amount> <token>\` to start earning.`);
        }
      } catch (err: any) {
        output(failure('EARN_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── positions ──────────────────────────────────────────

  earn
    .command('positions')
    .description('Show your vault positions')
    .option('--wallet <name>', 'Wallet to check')
    .option(protocolOption, protocolDesc)
    .action(async (opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() =>
          sdk.earn.getPositions(wallet.address, opts.protocol)
        );

        if (isJsonMode()) {
          output(success({ wallet: walletName, protocol: opts.protocol ?? 'all', positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No earn positions found.');
          console.log('Run `sol earn` to see available vaults.');
        } else {
          console.log('Earn Positions\n');

          console.log(table(
            positions.map(p => ({
              protocol: p.protocol,
              vault: p.vaultName,
              token: p.token,
              deposited: fmtAmount(p.depositedAmount),
              value: p.valueUsd != null ? `$${p.valueUsd.toFixed(2)}` : '—',
              apy: `${(p.apy * 100).toFixed(2)}%`,
            })),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'vault', header: 'Vault' },
              { key: 'token', header: 'Token' },
              { key: 'deposited', header: 'Deposited', align: 'right' },
              { key: 'value', header: 'Value', align: 'right' },
              { key: 'apy', header: 'APY', align: 'right' },
            ],
          ));

          const totalValue = positions.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
          console.log(`\nTotal earn value: $${totalValue.toFixed(2)}`);
          console.log(`Run \`sol earn withdraw max <token>\` to withdraw.`);
        }
      } catch (err: any) {
        output(failure('EARN_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── deposit ────────────────────────────────────────────

  if (isPermitted('canLend')) earn
    .command('deposit <amount> <token>')
    .description('Deposit into the best yield vault (or specify --protocol/--vault)')
    .option('--wallet <name>', 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .option('--vault <address>', 'Specific vault address')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const sdk = await ensureProviders();

        // Transaction limits check
        const tokenMeta = await sdk.registry.resolveToken(token);
        if (tokenMeta) {
          const prices = await sdk.price.getPrices([tokenMeta.mint]);
          const price = prices.get(tokenMeta.mint);
          assertWithinLimitsFromPrice(price?.priceUsd, amount, `earn deposit token ${tokenMeta.symbol}`);
        }

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          sdk.earn.deposit(walletName, token, amount, opts.protocol, opts.vault)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Deposited ${amount} ${token.toUpperCase()} into ${result.protocol} vault`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol earn positions\` to see your vault positions.`);
        }
      } catch (err: any) {
        output(failure('EARN_DEPOSIT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── withdraw ───────────────────────────────────────────

  if (isPermitted('canWithdrawLend')) earn
    .command('withdraw <amount> <token>')
    .description('Withdraw from a vault (use "max" for full withdrawal)')
    .option('--wallet <name>', 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseMaxAmount(amountStr);

        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          sdk.earn.withdraw(walletName, token, amount, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const label = isFinite(amount) ? `${amount} ${token.toUpperCase()}` : `all ${token.toUpperCase()}`;
          console.log(`Withdrew ${label} from ${result.protocol} vault`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol earn positions\` to check remaining positions.`);
        }
      } catch (err: any) {
        output(failure('EARN_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

// ── Helpers ───────────────────────────────────────────────

function fmtAmount(n: number): string {
  if (n >= 1_000_000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(9);
}

function parseMaxAmount(str: string): number {
  if (str === 'max' || str === 'all') return Infinity;
  const n = parseFloat(str);
  if (isNaN(n) || n <= 0) throw new Error('Invalid amount (use a number or "max")');
  return n;
}

function fmtLargeAmount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return fmtAmount(n);
}
