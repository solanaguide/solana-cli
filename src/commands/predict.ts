import { Command } from 'commander';
import * as predictService from '../core/predict-service.js';
import { PREDICT_CATEGORIES } from '../core/predict/predict-provider.js';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { isPermitted } from '../core/config-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import { shortenAddress } from '../utils/solana.js';
import * as walletRepo from '../db/repos/wallet-repo.js';
import * as predictionRepo from '../db/repos/prediction-repo.js';

export function registerPredictCommand(program: Command): void {
  const predict = program.command('predict').description('Prediction markets (Jupiter)');

  // ── list ────────────────────────────────────────────────

  predict
    .command('list [category]')
    .description(`Browse prediction events (${PREDICT_CATEGORIES.join(', ')})`)
    .option('--filter <type>', 'Filter: new, live, trending, upcoming')
    .option('--limit <n>', 'Number of results', '20')
    .action(async (category: string | undefined, opts) => {
      try {
        const { result: events, elapsed_ms } = await timed(() =>
          predictService.listEvents({
            category,
            filter: opts.filter,
            limit: parseInt(opts.limit),
          })
        );

        if (isJsonMode()) {
          output(success({ category: category ?? 'all', events }, { elapsed_ms }));
        } else if (events.length === 0) {
          console.log('No events found.');
        } else {
          console.log(table(
            events.map(e => ({
              id: shortenAddress(e.id, 6),
              title: truncate(e.title, 50),
              category: e.category,
              markets: String(e.markets.length),
              volume: fmtUsd(e.volume),
              status: e.status,
            })),
            [
              { key: 'id', header: 'Event ID' },
              { key: 'title', header: 'Title' },
              { key: 'category', header: 'Category' },
              { key: 'markets', header: 'Markets', align: 'right' },
              { key: 'volume', header: 'Volume', align: 'right' },
              { key: 'status', header: 'Status' },
            ],
          ));
          console.log(`\nShowing ${events.length} events. Run \`sol predict event <id>\` to see markets.`);
        }
      } catch (err: any) {
        output(failure('PREDICT_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── search ──────────────────────────────────────────────

  predict
    .command('search <query>')
    .description('Search prediction events by keyword')
    .option('--limit <n>', 'Number of results', '20')
    .action(async (query: string, opts) => {
      try {
        const { result: events, elapsed_ms } = await timed(() =>
          predictService.searchEvents(query, parseInt(opts.limit))
        );

        if (isJsonMode()) {
          output(success({ query, events }, { elapsed_ms }));
        } else if (events.length === 0) {
          console.log(`No events found for "${query}".`);
        } else {
          console.log(table(
            events.map(e => ({
              id: shortenAddress(e.id, 6),
              title: truncate(e.title, 50),
              category: e.category,
              markets: String(e.markets.length),
              volume: fmtUsd(e.volume),
            })),
            [
              { key: 'id', header: 'Event ID' },
              { key: 'title', header: 'Title' },
              { key: 'category', header: 'Category' },
              { key: 'markets', header: 'Markets', align: 'right' },
              { key: 'volume', header: 'Volume', align: 'right' },
            ],
          ));
          console.log(`\nFound ${events.length} events. Run \`sol predict event <id>\` to see markets.`);
        }
      } catch (err: any) {
        output(failure('PREDICT_SEARCH_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── event ───────────────────────────────────────────────

  predict
    .command('event <eventId>')
    .description('Show event details with all markets')
    .action(async (eventId: string) => {
      try {
        const { result: event, elapsed_ms } = await timed(() =>
          predictService.getEvent(eventId)
        );

        if (isJsonMode()) {
          output(success(event, { elapsed_ms }));
        } else {
          console.log(`${event.title}`);
          console.log(`Category: ${event.category} | Volume: ${fmtUsd(event.volume)} | Status: ${event.status}`);
          console.log('');

          if (event.markets.length === 0) {
            console.log('No markets for this event.');
          } else {
            console.log(table(
              event.markets.map(m => ({
                id: shortenAddress(m.id, 6),
                title: truncate(m.title, 40),
                yes: `$${m.yesPrice.toFixed(2)}`,
                no: `$${m.noPrice.toFixed(2)}`,
                volume: fmtUsd(m.volume),
                status: m.status,
              })),
              [
                { key: 'id', header: 'Market ID' },
                { key: 'title', header: 'Market' },
                { key: 'yes', header: 'YES', align: 'right' },
                { key: 'no', header: 'NO', align: 'right' },
                { key: 'volume', header: 'Volume', align: 'right' },
                { key: 'status', header: 'Status' },
              ],
            ));
            console.log(`\nRun \`sol predict buy <amount> yes|no <marketId>\` to buy contracts.`);
          }
        }
      } catch (err: any) {
        output(failure('PREDICT_EVENT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── market ──────────────────────────────────────────────

  predict
    .command('market <marketId>')
    .description('Market details — YES/NO prices, volume, orderbook')
    .action(async (marketId: string) => {
      try {
        const { result, elapsed_ms } = await timed(async () => {
          const [market, orderbookResult] = await Promise.all([
            predictService.getMarket(marketId),
            predictService.getOrderbook(marketId).catch(() => null),
          ]);
          return { market, orderbook: orderbookResult };
        });

        const { market, orderbook } = result;

        if (isJsonMode()) {
          output(success({ market, orderbook }, { elapsed_ms }));
        } else {
          console.log(`${market.title}`);
          console.log(`YES: $${market.yesPrice.toFixed(4)} | NO: $${market.noPrice.toFixed(4)} | Volume: ${fmtUsd(market.volume)}`);
          console.log(`Status: ${market.status}${market.resolution ? ` (resolved: ${market.resolution.toUpperCase()})` : ''}`);

          if (orderbook) {
            console.log('');
            if (orderbook.yes.length > 0) {
              console.log('YES Orderbook');
              console.log(table(
                orderbook.yes.slice(0, 10).map(l => ({
                  price: `$${l.price.toFixed(2)}`,
                  quantity: String(l.quantity),
                })),
                [
                  { key: 'price', header: 'Price', align: 'right' },
                  { key: 'quantity', header: 'Qty', align: 'right' },
                ],
              ));
            }
            if (orderbook.no.length > 0) {
              console.log('NO Orderbook');
              console.log(table(
                orderbook.no.slice(0, 10).map(l => ({
                  price: `$${l.price.toFixed(2)}`,
                  quantity: String(l.quantity),
                })),
                [
                  { key: 'price', header: 'Price', align: 'right' },
                  { key: 'quantity', header: 'Qty', align: 'right' },
                ],
              ));
            }
          }

          console.log(`\nRun \`sol predict buy <amount> yes|no ${marketId}\` to buy contracts.`);
        }
      } catch (err: any) {
        output(failure('PREDICT_MARKET_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── buy ─────────────────────────────────────────────────

  if (isPermitted('canPredict')) predict
    .command('buy <amount> <side> <marketId>')
    .description('Buy YES or NO contracts on a prediction market')
    .option('--wallet <name>', 'Wallet to use')
    .option('--max-price <price>', 'Maximum price per contract (0-1)')
    .action(async (amountStr: string, side: string, marketId: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const normalizedSide = side.toLowerCase();
        if (normalizedSide !== 'yes' && normalizedSide !== 'no') {
          throw new Error('Side must be "yes" or "no"');
        }
        const isYes = normalizedSide === 'yes';

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const maxPrice = opts.maxPrice ? parseFloat(opts.maxPrice) : undefined;
        if (maxPrice != null && (isNaN(maxPrice) || maxPrice <= 0 || maxPrice >= 1)) {
          throw new Error('Max price must be between 0 and 1');
        }

        const { result, elapsed_ms } = await timed(() =>
          predictService.buy(walletName, marketId, isYes, amount, maxPrice)
        );

        // Track position locally
        try {
          predictionRepo.insertPosition({
            position_pubkey: result.positionPubkey,
            provider: 'jupiter',
            wallet_name: walletName,
            wallet_address: wallet.address,
            market_id: marketId,
            is_yes: isYes,
            contracts: result.contracts,
            cost_basis_usd: result.costUsd,
            deposit_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            deposit_amount: String(amount),
            buy_signature: result.signature,
          });
        } catch {
          // Position tracking is best-effort
        }

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Bought ${result.contracts} ${isYes ? 'YES' : 'NO'} contracts at $${result.priceUsd.toFixed(4)}`);
          console.log(`  Cost: $${result.costUsd.toFixed(2)} USDC`);
          if (result.estimatedFeeUsd > 0) {
            console.log(`  Estimated fee: $${result.estimatedFeeUsd.toFixed(4)}`);
          }
          console.log(`  Position: ${shortenAddress(result.positionPubkey, 6)}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol predict positions\` to track your positions.`);
        }
      } catch (err: any) {
        output(failure('PREDICT_BUY_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── sell ─────────────────────────────────────────────────

  if (isPermitted('canPredict')) predict
    .command('sell <positionPubkey>')
    .description('Sell/close an open prediction position')
    .option('--wallet <name>', 'Wallet to use')
    .option('--min-price <price>', 'Minimum sell price per contract (0-1)')
    .action(async (positionPubkey: string, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const minPrice = opts.minPrice ? parseFloat(opts.minPrice) : undefined;

        const { result, elapsed_ms } = await timed(() =>
          predictService.sell(walletName, positionPubkey, minPrice)
        );

        // Update local tracking
        predictionRepo.updatePositionClosed(
          positionPubkey, result.signature, result.realizedPnlUsd
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Sold ${result.contracts} contracts`);
          console.log(`  Proceeds: $${result.proceedsUsd.toFixed(2)} USDC`);
          const pnlSign = result.realizedPnlUsd >= 0 ? '+' : '';
          console.log(`  P&L: ${pnlSign}$${result.realizedPnlUsd.toFixed(2)}`);
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('PREDICT_SELL_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── claim ───────────────────────────────────────────────

  if (isPermitted('canPredict')) predict
    .command('claim <positionPubkey>')
    .description('Claim winnings on a resolved market')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (positionPubkey: string, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result, elapsed_ms } = await timed(() =>
          predictService.claim(walletName, positionPubkey)
        );

        // Update local tracking
        const localPos = predictionRepo.getPosition(positionPubkey);
        const costBasis = localPos?.cost_basis_usd ?? 0;
        predictionRepo.updatePositionClaimed(
          positionPubkey, result.signature, result.payoutUsd - costBasis
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Claimed ${result.contracts} contracts`);
          console.log(`  Payout: $${result.payoutUsd.toFixed(2)} USDC`);
          if (costBasis > 0) {
            const pnl = result.payoutUsd - costBasis;
            const pnlSign = pnl >= 0 ? '+' : '';
            console.log(`  P&L: ${pnlSign}$${pnl.toFixed(2)}`);
          }
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('PREDICT_CLAIM_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── positions ───────────────────────────────────────────

  predict
    .command('positions')
    .description('List all open/claimable prediction positions')
    .option('--wallet <name>', 'Wallet to check')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() =>
          predictService.getPositions(wallet.address)
        );

        if (isJsonMode()) {
          output(success({ wallet: walletName, positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No prediction positions found.');
          console.log('Run `sol predict list` to browse markets.');
        } else {
          console.log(table(
            positions.map(p => {
              const pnlStr = p.unrealizedPnlUsd != null
                ? `${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)}`
                : '—';
              return {
                position: shortenAddress(p.pubkey, 6),
                market: positionLabel(p.eventTitle, p.marketTitle, 40),
                side: p.isYes ? 'YES' : 'NO',
                contracts: String(p.contracts),
                cost: `$${p.costBasisUsd.toFixed(2)}`,
                value: p.currentValueUsd != null ? `$${p.currentValueUsd.toFixed(2)}` : '—',
                pnl: pnlStr,
                status: p.status,
              };
            }),
            [
              { key: 'position', header: 'Position' },
              { key: 'market', header: 'Market' },
              { key: 'side', header: 'Side' },
              { key: 'contracts', header: 'Contracts', align: 'right' },
              { key: 'cost', header: 'Cost', align: 'right' },
              { key: 'value', header: 'Value', align: 'right' },
              { key: 'pnl', header: 'P&L', align: 'right' },
              { key: 'status', header: 'Status' },
            ],
          ));

          const claimable = positions.filter(p => p.claimable);
          if (claimable.length > 0) {
            console.log(`\n${claimable.length} position${claimable.length > 1 ? 's' : ''} claimable. Run \`sol predict claim <positionPubkey>\` to collect winnings.`);
          }
        }
      } catch (err: any) {
        output(failure('PREDICT_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── history ─────────────────────────────────────────────

  predict
    .command('history')
    .description('Prediction market transaction history')
    .option('--wallet <name>', 'Wallet to check')
    .option('--limit <n>', 'Number of entries', '50')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: entries, elapsed_ms } = await timed(() =>
          predictService.getHistory(wallet.address, parseInt(opts.limit))
        );

        if (isJsonMode()) {
          output(success({ wallet: walletName, history: entries }, { elapsed_ms }));
        } else if (entries.length === 0) {
          console.log('No prediction history found.');
        } else {
          console.log(table(
            entries.map(e => ({
              type: e.eventType.replace('order_', '').replace('payout_', '').replace('position_', ''),
              market: positionLabel(e.eventTitle, e.marketTitle, 40),
              side: e.isYes ? 'YES' : 'NO',
              contracts: String(e.contracts),
              price: e.priceUsd > 0 ? `$${e.priceUsd.toFixed(4)}` : '—',
              fee: e.feeUsd > 0 ? `$${e.feeUsd.toFixed(4)}` : '—',
              date: e.timestamp ? new Date(e.timestamp * 1000).toLocaleDateString() : '—',
            })),
            [
              { key: 'type', header: 'Action' },
              { key: 'market', header: 'Market' },
              { key: 'side', header: 'Side' },
              { key: 'contracts', header: 'Contracts', align: 'right' },
              { key: 'price', header: 'Price', align: 'right' },
              { key: 'fee', header: 'Fee', align: 'right' },
              { key: 'date', header: 'Date' },
            ],
          ));
        }
      } catch (err: any) {
        output(failure('PREDICT_HISTORY_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

// ── Helpers ───────────────────────────────────────────────

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/** Combine event + market title for human-readable context.
 *  "What price will Solana hit in 2026?" + "↑ 200" → "Solana hit in 2026? ↑ 200" */
function positionLabel(eventTitle: string, marketTitle: string, maxLen: number): string {
  if (!eventTitle) return truncate(marketTitle || '—', maxLen);
  if (!marketTitle || eventTitle === marketTitle) return truncate(eventTitle, maxLen);
  // Shorten event title to make room for market suffix
  const suffix = ` — ${marketTitle}`;
  const budget = maxLen - suffix.length;
  if (budget < 10) return truncate(eventTitle, maxLen);
  return truncate(eventTitle, budget) + suffix;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
