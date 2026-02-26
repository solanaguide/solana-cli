import { type Command } from 'commander';
import {
  createDcaOrder,
  listDcaOrders,
  cancelDcaOrder,
  createLimitOrder,
  listLimitOrders,
  cancelLimitOrder,
  parseInterval,
} from '../core/order-service.js';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { resolveToken } from '../core/token-registry.js';
import { output, success, failure, isJsonMode, timed, fmtPrice } from '../output/formatter.js';
import { table } from '../output/table.js';
import { isPermitted } from '../core/config-manager.js';
import * as walletRepo from '../db/repos/wallet-repo.js';
import { explorerUrl } from '../utils/solana.js';

export function registerOrderCommands(token: Command): void {
  // ── DCA ────────────────────────────────────────────────────

  const dca = token.command('dca').description('Dollar-cost average orders (Jupiter Recurring)');

  if (isPermitted('canSwap')) dca
    .command('new <amount> <from> <to>')
    .description('Create a DCA order (e.g., sol token dca new 500 usdc sol --every day --count 10)')
    .requiredOption('--every <interval>', 'Interval: minute, hour, day, week, month')
    .option('--count <n>', 'Number of orders', parseInt, 10)
    .option('--wallet <name>', 'Wallet to use')
    .option('--quote-only', 'Show plan without executing')
    .action(async (amountStr: string, from: string, to: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        if (opts.quoteOnly) {
          parseInterval(opts.every); // validate early
          if (opts.count < 2) throw new Error('DCA requires at least 2 orders');
          const amountPerOrder = amount / opts.count;
          if (isJsonMode()) {
            output(success({
              type: 'dca_plan',
              inputSymbol: from.toUpperCase(),
              outputSymbol: to.toUpperCase(),
              totalAmount: amount,
              amountPerOrder,
              count: opts.count,
              interval: opts.every,
            }));
          } else {
            console.log(`DCA Plan:`);
            console.log(`  ${amount} ${from.toUpperCase()} → ${to.toUpperCase()}`);
            console.log(`  ${opts.count} orders of ${amountPerOrder.toFixed(4)} ${from.toUpperCase()} each`);
            console.log(`  Every ${opts.every}`);
            console.log(`\nRun without --quote-only to execute.`);
          }
          return;
        }

        const { result, elapsed_ms } = await timed(() =>
          createDcaOrder(amount, from, to, walletName, {
            interval: opts.every,
            count: opts.count,
          })
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`\nDCA order created!`);
          console.log(`  ${result.totalAmount} ${result.inputSymbol} → ${result.outputSymbol}`);
          console.log(`  ${result.count} orders of ${result.amountPerOrder.toFixed(4)} ${result.inputSymbol} every ${result.interval}`);
          console.log(`  Signature: ${result.signature}`);
          console.log(`  Explorer: ${explorerUrl(result.signature)}`);
          console.log(`\nRun \`sol token dca list\` to check status.`);
        }
      } catch (err: any) {
        output(failure('DCA_CREATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  dca
    .command('list')
    .description('List open DCA orders')
    .option('--wallet <name>', 'Wallet to use')
    .option('--history', 'Show completed/cancelled orders')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: orders, elapsed_ms } = await timed(() =>
          listDcaOrders(wallet.address, { status: opts.history ? 'history' : 'active' })
        );

        // Try to resolve token symbols
        for (const order of orders) {
          try {
            const input = await resolveToken(order.inputMint);
            const output = await resolveToken(order.outputMint);
            if (input) order.inputSymbol = input.symbol;
            if (output) order.outputSymbol = output.symbol;
          } catch { /* non-critical */ }
        }

        if (isJsonMode()) {
          output(success({ wallet: walletName, orders }, { elapsed_ms }));
        } else {
          console.log(`DCA orders for "${walletName}"${opts.history ? ' (history)' : ''}:\n`);
          if (orders.length === 0) {
            console.log('  No orders found.');
          } else {
            console.log(table(
              orders.map(o => ({
                pair: `${o.inputSymbol || truncMint(o.inputMint)} → ${o.outputSymbol || truncMint(o.outputMint)}`,
                perCycle: o.inAmountPerCycle,
                frequency: o.cycleFrequency ? formatFrequency(parseInt(o.cycleFrequency)) : '—',
                deposited: o.inDeposited,
                used: o.inUsed,
                received: o.outReceived,
                status: o.status,
                orderKey: truncMint(o.orderKey),
              })),
              [
                { key: 'pair', header: 'Pair' },
                { key: 'perCycle', header: 'Per Order', align: 'right' },
                { key: 'frequency', header: 'Interval' },
                { key: 'used', header: 'Used', align: 'right' },
                { key: 'received', header: 'Received', align: 'right' },
                { key: 'status', header: 'Status' },
                { key: 'orderKey', header: 'Order Key' },
              ]
            ));
          }
          console.log(`\nCancel with: sol token dca cancel <orderKey>`);
        }
      } catch (err: any) {
        output(failure('DCA_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canSwap')) dca
    .command('cancel <orderKey>')
    .description('Cancel a DCA order')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (orderKey: string, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result: signature, elapsed_ms } = await timed(() =>
          cancelDcaOrder(orderKey, walletName)
        );

        if (isJsonMode()) {
          output(success({ signature, orderKey, action: 'cancelled' }, { elapsed_ms }));
        } else {
          console.log(`DCA order cancelled.`);
          console.log(`  Order: ${truncMint(orderKey)}`);
          console.log(`  Signature: ${signature}`);
          console.log(`  Explorer: ${explorerUrl(signature)}`);
        }
      } catch (err: any) {
        output(failure('DCA_CANCEL_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── Limit Orders ───────────────────────────────────────────

  const limit = token.command('limit').description('Limit orders (Jupiter Trigger)');

  if (isPermitted('canSwap')) limit
    .command('new <amount> <from> <to>')
    .description('Create a limit order (e.g., sol token limit new 50 usdc bonk --at 0.00002)')
    .requiredOption('--at <price>', 'Target USD price for output token', parseFloat)
    .option('--slippage <bps>', 'Slippage tolerance in basis points', parseInt)
    .option('--wallet <name>', 'Wallet to use')
    .option('--quote-only', 'Show plan without executing')
    .action(async (amountStr: string, from: string, to: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
        if (isNaN(opts.at) || opts.at <= 0) throw new Error('Invalid target price');

        if (opts.quoteOnly) {
          // Estimate output for display
          const inputToken = await resolveToken(from);
          if (!inputToken) throw new Error(`Unknown token: ${from}`);
          const outputToken = await resolveToken(to);
          if (!outputToken) throw new Error(`Unknown token: ${to}`);

          // Try to get current input price
          let currentInputPrice: number | undefined;
          let currentOutputPrice: number | undefined;
          try {
            const { getPrices } = await import('../core/price-service.js');
            const prices = await getPrices([inputToken.mint, outputToken.mint]);
            currentInputPrice = prices.get(inputToken.mint)?.priceUsd;
            currentOutputPrice = prices.get(outputToken.mint)?.priceUsd;
          } catch { /* ok */ }

          const estimatedOutput = currentInputPrice ? (amount * currentInputPrice) / opts.at : undefined;

          if (isJsonMode()) {
            output(success({
              type: 'limit_plan',
              inputSymbol: inputToken.symbol,
              outputSymbol: outputToken.symbol,
              inputAmount: amount,
              targetPriceUsd: opts.at,
              estimatedOutput,
              currentOutputPriceUsd: currentOutputPrice,
            }));
          } else {
            console.log(`Limit Order Plan:`);
            console.log(`  Spend: ${amount} ${inputToken.symbol}`);
            console.log(`  Buy: ${outputToken.symbol} at $${fmtPrice(opts.at)}`);
            if (estimatedOutput != null) {
              console.log(`  Est. output: ${estimatedOutput.toFixed(6)} ${outputToken.symbol}`);
            }
            if (currentOutputPrice != null) {
              const pctFromCurrent = ((opts.at / currentOutputPrice - 1) * 100);
              const direction = opts.at > currentOutputPrice
                ? `target is ${pctFromCurrent.toFixed(1)}% above current — may fill immediately`
                : `target is ${Math.abs(pctFromCurrent).toFixed(1)}% below current`;
              console.log(`  Current ${outputToken.symbol}: $${fmtPrice(currentOutputPrice)} (${direction})`);
            }
            console.log(`\nRun without --quote-only to execute.`);
          }
          return;
        }

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          createLimitOrder(amount, from, to, walletName, {
            targetPrice: opts.at,
            slippageBps: opts.slippage,
          })
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`\nLimit order created!`);
          console.log(`  Spend: ${result.inputAmount} ${result.inputSymbol}`);
          console.log(`  Buy: ${result.outputAmount.toFixed(6)} ${result.outputSymbol} at $${fmtPrice(result.targetPrice)}`);
          console.log(`  Signature: ${result.signature}`);
          console.log(`  Explorer: ${explorerUrl(result.signature)}`);
          console.log(`\nRun \`sol token limit list\` to check status.`);
        }
      } catch (err: any) {
        output(failure('LIMIT_CREATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  limit
    .command('list')
    .description('List open limit orders')
    .option('--wallet <name>', 'Wallet to use')
    .option('--history', 'Show completed/cancelled orders')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: orders, elapsed_ms } = await timed(() =>
          listLimitOrders(wallet.address, { status: opts.history ? 'history' : 'active' })
        );

        // Try to resolve token symbols
        for (const order of orders) {
          try {
            const input = await resolveToken(order.inputMint);
            const outputTok = await resolveToken(order.outputMint);
            if (input) order.inputSymbol = input.symbol;
            if (outputTok) order.outputSymbol = outputTok.symbol;
          } catch { /* non-critical */ }
        }

        if (isJsonMode()) {
          output(success({ wallet: walletName, orders }, { elapsed_ms }));
        } else {
          console.log(`Limit orders for "${walletName}"${opts.history ? ' (history)' : ''}:\n`);
          if (orders.length === 0) {
            console.log('  No orders found.');
          } else {
            console.log(table(
              orders.map(o => ({
                pair: `${o.inputSymbol || truncMint(o.inputMint)} → ${o.outputSymbol || truncMint(o.outputMint)}`,
                input: o.makingAmount,
                target: o.takingAmount,
                remaining: o.remainingMakingAmount,
                status: o.status,
                created: o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—',
                orderKey: truncMint(o.orderKey),
              })),
              [
                { key: 'pair', header: 'Pair' },
                { key: 'input', header: 'Input', align: 'right' },
                { key: 'target', header: 'Target', align: 'right' },
                { key: 'remaining', header: 'Remaining', align: 'right' },
                { key: 'status', header: 'Status' },
                { key: 'created', header: 'Created' },
                { key: 'orderKey', header: 'Order Key' },
              ]
            ));
          }
          console.log(`\nCancel with: sol token limit cancel <orderKey>`);
        }
      } catch (err: any) {
        output(failure('LIMIT_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canSwap')) limit
    .command('cancel <orderKey>')
    .description('Cancel a limit order')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (orderKey: string, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result: signature, elapsed_ms } = await timed(() =>
          cancelLimitOrder(orderKey, walletName)
        );

        if (isJsonMode()) {
          output(success({ signature, orderKey, action: 'cancelled' }, { elapsed_ms }));
        } else {
          console.log(`Limit order cancelled.`);
          console.log(`  Order: ${truncMint(orderKey)}`);
          console.log(`  Signature: ${signature}`);
          console.log(`  Explorer: ${explorerUrl(signature)}`);
        }
      } catch (err: any) {
        output(failure('LIMIT_CANCEL_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

// ── Helpers ────────────────────────────────────────────────

function truncMint(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}..${addr.slice(-4)}`;
}

function formatFrequency(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 1209600) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / 604800)}w`;
}
