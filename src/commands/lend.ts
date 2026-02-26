import { Command } from 'commander';
import * as lendService from '../core/lend-service.js';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { isPermitted } from '../core/config-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';
import { PROTOCOL_NAMES } from '../core/lend/lend-provider.js';

export function registerLendCommand(program: Command): void {
  const lend = program.command('lend').description('Lending and borrowing (Kamino, MarginFi, Drift, Jupiter, Loopscale)');

  const protocolOption = `--protocol <name>`;
  const protocolDesc = `Protocol to use (${PROTOCOL_NAMES.join(', ')})`;

  // ── rates ───────────────────────────────────────────────

  lend
    .command('rates [tokens...]')
    .description('Show deposit/borrow APY across lending protocols')
    .option(protocolOption, protocolDesc)
    .action(async (tokens: string[], opts) => {
      try {
        const filterTokens = tokens.length > 0 ? tokens : undefined;
        const { result, elapsed_ms } = await timed(() =>
          lendService.getRates(filterTokens, opts.protocol)
        );

        if (isJsonMode()) {
          output(success({
            tokens: filterTokens ?? 'all',
            protocol: opts.protocol ?? 'all',
            rates: result.rates,
            warnings: result.warnings,
            bestDepositProtocol: result.bestDepositProtocol,
            bestBorrowProtocol: result.bestBorrowProtocol,
          }, { elapsed_ms }));
        } else if (result.rates.length === 0) {
          const label = filterTokens ? filterTokens.join(', ') : 'any tokens';
          console.log(`No lending reserves found for ${label}.`);
        } else {
          const protoLabel = opts.protocol ? ` — ${opts.protocol}` : '';
          console.log(`Lending Rates${protoLabel}${filterTokens ? ' — ' + filterTokens.join(', ') : ''}\n`);

          // Sort by token, then deposit APY desc
          const sorted = [...result.rates].sort((a, b) => {
            if (a.token !== b.token) return a.token.localeCompare(b.token);
            return b.depositApy - a.depositApy;
          });

          console.log(table(
            sorted.map(r => {
              const isBestDeposit = result.bestDepositProtocol[r.token] === r.protocol;
              const depositLabel = `${(r.depositApy * 100).toFixed(2)}%${isBestDeposit ? ' *' : ''}`;

              return {
                protocol: r.protocol,
                token: r.token,
                depositApy: depositLabel,
                borrowApy: r.borrowApy > 0 ? `${(r.borrowApy * 100).toFixed(2)}%` : '—',
                utilization: r.utilizationPct > 0 ? `${r.utilizationPct.toFixed(1)}%` : '—',
                totalDeposited: fmtLargeAmount(r.totalDeposited),
              };
            }),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'token', header: 'Token' },
              { key: 'depositApy', header: 'Deposit APY', align: 'right' },
              { key: 'borrowApy', header: 'Borrow APY', align: 'right' },
              { key: 'utilization', header: 'Utilization', align: 'right' },
              { key: 'totalDeposited', header: 'Total Deposited', align: 'right' },
            ]
          ));

          if (result.warnings.length > 0) {
            console.log('');
            for (const w of result.warnings) {
              console.log(`  Warning: ${w}`);
            }
          }

          console.log(`\n* = best rate. Run \`sol lend deposit <amount> <token>\` to start earning.`);
        }
      } catch (err: any) {
        output(failure('LEND_RATES_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── positions ───────────────────────────────────────────

  lend
    .command('positions')
    .description('List all lending/borrowing positions across protocols')
    .option('--wallet <name>', 'Wallet to check')
    .option(protocolOption, protocolDesc)
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() =>
          lendService.getPositions(wallet.address, opts.protocol)
        );

        if (isJsonMode()) {
          output(success({ wallet: walletName, protocol: opts.protocol ?? 'all', positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No lending positions found.');
          console.log('Run `sol lend rates` to see available rates across protocols.');
        } else {
          const deposits = positions.filter(p => p.type === 'deposit');
          const borrows = positions.filter(p => p.type === 'borrow');

          if (deposits.length > 0) {
            console.log('Deposits');
            console.log(table(
              deposits.map(p => ({
                protocol: p.protocol,
                token: p.token,
                amount: fmtAmount(p.amount),
                value: `$${p.valueUsd.toFixed(2)}`,
                apy: `${(p.apy * 100).toFixed(2)}%`,
              })),
              [
                { key: 'protocol', header: 'Protocol' },
                { key: 'token', header: 'Token' },
                { key: 'amount', header: 'Amount', align: 'right' },
                { key: 'value', header: 'Value', align: 'right' },
                { key: 'apy', header: 'APY', align: 'right' },
              ],
            ));
            console.log('');
          }

          if (borrows.length > 0) {
            console.log('Borrows');
            console.log(table(
              borrows.map(p => ({
                protocol: p.protocol,
                token: p.token,
                amount: fmtAmount(p.amount),
                value: `$${p.valueUsd.toFixed(2)}`,
                apy: `${(p.apy * 100).toFixed(2)}%`,
                health: p.healthFactor != null ? p.healthFactor.toFixed(2) : '—',
              })),
              [
                { key: 'protocol', header: 'Protocol' },
                { key: 'token', header: 'Token' },
                { key: 'amount', header: 'Amount', align: 'right' },
                { key: 'value', header: 'Value', align: 'right' },
                { key: 'apy', header: 'APY', align: 'right' },
                { key: 'health', header: 'Health', align: 'right' },
              ],
            ));

            // Health factor warning
            const minHealth = Math.min(...borrows.map(p => p.healthFactor ?? Infinity));
            if (minHealth < 1.1) {
              console.log('\nWarning: health factor below 1.1. Consider repaying or adding collateral.');
            }
            console.log('');
          }

          // Summary per protocol
          const protoSummary = new Map<string, { deposits: number; borrows: number }>();
          for (const p of positions) {
            const s = protoSummary.get(p.protocol) ?? { deposits: 0, borrows: 0 };
            if (p.type === 'deposit') s.deposits += p.valueUsd;
            else s.borrows += p.valueUsd;
            protoSummary.set(p.protocol, s);
          }

          const totalDeposits = deposits.reduce((s, p) => s + p.valueUsd, 0);
          const totalBorrows = borrows.reduce((s, p) => s + p.valueUsd, 0);

          if (protoSummary.size > 1) {
            for (const [proto, s] of protoSummary) {
              const net = s.deposits - s.borrows;
              console.log(`  ${proto}: $${net.toFixed(2)} net`);
            }
          }

          console.log(`Net lending value: $${(totalDeposits - totalBorrows).toFixed(2)}`);
        }
      } catch (err: any) {
        output(failure('LEND_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── deposit ─────────────────────────────────────────────

  if (isPermitted('canLend')) lend
    .command('deposit <amount> <token>')
    .description('Deposit into a lending protocol (auto-picks best rate or use --protocol)')
    .option('--wallet <name>', 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.deposit(walletName, token, amount, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Deposited ${amount} ${token.toUpperCase()} into ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol lend positions\` to see your deposits.`);
        }
      } catch (err: any) {
        output(failure('LEND_DEPOSIT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── withdraw ────────────────────────────────────────────

  if (isPermitted('canWithdrawLend')) lend
    .command('withdraw <amount> <token>')
    .description('Withdraw from a lending position (use "max" for full withdrawal)')
    .option('--wallet <name>', 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseMaxAmount(amountStr);

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.withdraw(walletName, token, amount, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const label = isFinite(amount) ? `${amount} ${token.toUpperCase()}` : `all ${token.toUpperCase()}`;
          console.log(`Withdrew ${label} from ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol lend positions\` to check remaining positions.`);
        }
      } catch (err: any) {
        output(failure('LEND_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── borrow ──────────────────────────────────────────────

  if (isPermitted('canLend')) lend
    .command('borrow <amount> <token>')
    .description('Borrow against collateral (Kamino, MarginFi, Drift, Loopscale)')
    .option('--collateral <token>', 'Collateral token (required)')
    .option('--wallet <name>', 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
        if (!opts.collateral) throw new Error('--collateral is required');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.borrow(walletName, token, amount, opts.collateral, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Borrowed ${amount} ${token.toUpperCase()} from ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          if (result.healthFactor != null) {
            console.log(`  Health factor: ${result.healthFactor.toFixed(2)}`);
            if (result.healthFactor < 1.1) {
              console.log('  Warning: health factor is low. Monitor closely.');
            }
          }
          console.log(`\nRun \`sol lend positions\` to view all positions.`);
        }
      } catch (err: any) {
        output(failure('LEND_BORROW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── repay ───────────────────────────────────────────────

  if (isPermitted('canWithdrawLend')) lend
    .command('repay <amount> <token>')
    .description('Repay a loan (use "max" to repay full debt)')
    .option('--wallet <name>', 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseMaxAmount(amountStr);

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.repay(walletName, token, amount, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const label = isFinite(amount) ? `${amount} ${token.toUpperCase()}` : `all ${token.toUpperCase()}`;
          console.log(`Repaid ${label} on ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          if (result.remainingDebt != null) {
            if (result.remainingDebt === 0) {
              console.log('  Loan fully repaid!');
            } else {
              console.log(`  Remaining debt: ${fmtAmount(result.remainingDebt)} ${token.toUpperCase()}`);
            }
          }
          console.log(`\nRun \`sol lend positions\` to check remaining positions.`);
        }
      } catch (err: any) {
        output(failure('LEND_REPAY_FAILED', err.message));
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
