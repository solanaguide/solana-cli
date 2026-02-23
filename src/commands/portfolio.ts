import { Command } from 'commander';
import { getDefaultWalletName } from '../core/wallet-manager.js';
import * as portfolioService from '../core/portfolio-service.js';
import * as snapshotRepo from '../db/repos/snapshot-repo.js';
import { renderPortfolio, renderCompare } from '../output/portfolio-renderer.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';

export function registerPortfolioCommand(program: Command): void {
  const portfolio = program
    .command('portfolio')
    .description('Unified view of everything you hold — tokens, staking, allocation')
    .option('--wallet <name>', 'Show only this wallet')
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      try {
        const { result: report, elapsed_ms } = await timed(() =>
          portfolioService.getPortfolio(opts.wallet)
        );

        // Auto-snapshot if stale (fire-and-forget, don't block output)
        portfolioService.autoSnapshotIfStale().catch(() => {});

        if (isJsonMode()) {
          output(success(report, { elapsed_ms }));
        } else {
          console.log(renderPortfolio(report));
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_FETCH_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── snapshot ────────────────────────────────────────────

  portfolio
    .command('snapshot')
    .description('Save current portfolio state for later comparison')
    .option('--label <label>', 'Label for this snapshot')
    .option('--wallet <name>', 'Snapshot only this wallet')
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const { result: data, elapsed_ms } = await timed(() =>
          portfolioService.takeSnapshot(opts.label, globalOpts.wallet)
        );

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`Snapshot #${data.snapshotId} taken`);
          console.log(`  Wallets: ${data.walletCount}`);
          console.log(`  Entries: ${data.entryCount}`);
          console.log(`  Total value: $${data.totalValueUsd.toFixed(2)}`);
          console.log(`\nRun \`sol portfolio compare\` to diff against this snapshot later.`);
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_SNAPSHOT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── history ─────────────────────────────────────────────

  portfolio
    .command('history')
    .description('List past snapshots')
    .action(() => {
      try {
        const snapshots = snapshotRepo.listSnapshots();

        if (isJsonMode()) {
          output(success(snapshots));
        } else if (snapshots.length === 0) {
          console.log('No snapshots found. Take one with: sol portfolio snapshot');
        } else {
          console.log(table(
            snapshots.map(s => ({
              id: String(s.id),
              label: s.label || '—',
              date: s.created_at,
            })),
            [
              { key: 'id', header: 'ID' },
              { key: 'label', header: 'Label' },
              { key: 'date', header: 'Date' },
            ],
          ));
          console.log(`\n${snapshots.length} snapshot(s). Run \`sol portfolio compare <id>\` to diff.`);
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_HISTORY_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── compare ─────────────────────────────────────────────

  portfolio
    .command('compare [id]')
    .description('Compare current holdings vs a snapshot (defaults to most recent)')
    .option('--wallet <name>', 'Compare only this wallet')
    .action(async (idStr?: string, opts?: any, cmd?: any) => {
      const globalOpts = (cmd ?? opts)?.optsWithGlobals?.() ?? {};
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const id = idStr ? parseInt(idStr) : undefined;
          return portfolioService.compareToSnapshot(id, globalOpts.wallet);
        });

        const snapLabel = data.snapshotDate
          ? `Snapshot #${data.snapshotId} (${data.snapshotDate})`
          : `Snapshot #${data.snapshotId}`;

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(renderCompare(data, `Current vs ${snapLabel}:`));
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_COMPARE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── pnl ─────────────────────────────────────────────────

  portfolio
    .command('pnl')
    .description('P&L since first snapshot (or --since <id>)')
    .option('--since <id>', 'Compute P&L since this snapshot')
    .option('--wallet <name>', 'P&L for only this wallet')
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      try {
        const { result: data, elapsed_ms } = await timed(() => {
          const sinceId = opts.since ? parseInt(opts.since) : undefined;
          return portfolioService.getPnl(sinceId, globalOpts.wallet);
        });

        const snapLabel = data.snapshotDate
          ? `since Snapshot #${data.snapshotId} (${data.snapshotDate})`
          : `since Snapshot #${data.snapshotId}`;

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(renderCompare(data, `P&L ${snapLabel}:`));
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_PNL_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── delete ──────────────────────────────────────────────

  portfolio
    .command('delete <id>')
    .description('Delete a snapshot')
    .action((idStr: string) => {
      try {
        const id = parseInt(idStr);
        const deleted = snapshotRepo.deleteSnapshot(id);
        if (!deleted) throw new Error(`Snapshot #${id} not found`);

        if (isJsonMode()) {
          output(success({ id, deleted: true }));
        } else {
          console.log(`Deleted snapshot #${id}`);
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_DELETE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── cron ────────────────────────────────────────────────

  portfolio
    .command('cron')
    .description('Print a crontab entry for automated daily snapshots')
    .action(() => {
      try {
        const solPath = process.argv[1] || 'sol';
        const entry = `0 0 * * * ${solPath} portfolio snapshot --label auto 2>/dev/null`;

        if (isJsonMode()) {
          output(success({ crontab: entry }));
        } else {
          console.log('# Sol CLI — daily portfolio snapshot at midnight');
          console.log(entry);
          console.log('\nPaste this into `crontab -e` to auto-snapshot daily.');
        }
      } catch (err: any) {
        output(failure('PORTFOLIO_CRON_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
