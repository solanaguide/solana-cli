import { Command } from 'commander';
import { x402Fetch } from '../core/x402-service.js';
import { isPermitted } from '../core/config-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { explorerUrl } from '../utils/solana.js';

export function registerFetchCommand(program: Command): void {
  if (!isPermitted('canFetch')) return;

  program
    .command('fetch <url>')
    .description('Fetch a URL, auto-paying x402 Payment Required responses with USDC')
    .option('-X, --method <method>', 'HTTP method (GET, POST, etc.)')
    .option('-d, --body <data>', 'Request body')
    .option('-H, --header <header...>', 'Custom headers (repeatable, e.g. -H "Accept: application/json")')
    .option('--max <amount>', 'Max USDC to spend (spending cap)')
    .option('--dry-run', 'Show payment requirements without paying')
    .option('--wallet <name>', 'Wallet to use for payments')
    .action(async (url: string, opts) => {
      try {
        const { result, elapsed_ms } = await timed(() =>
          x402Fetch(url, {
            method: opts.method,
            body: opts.body,
            headers: opts.header,
            maxUsdc: opts.max != null ? parseFloat(opts.max) : undefined,
            dryRun: opts.dryRun,
            walletName: opts.wallet,
          })
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else if (opts.dryRun && result.requirements) {
          const amountUsdc = result.payment?.amountUsdc ?? 0;
          console.log('Payment Required (x402)');
          console.log(`  Amount:    $${amountUsdc.toFixed(6)} USDC`);
          console.log(`  Recipient: ${result.requirements.payTo}`);
          console.log(`  Network:   ${result.requirements.network}`);
          console.log(`\nRun without --dry-run to pay and fetch the resource.`);
        } else if (result.paid && result.payment) {
          // Payment info to stderr so stdout is clean for piping
          const amt = result.payment.amountUsdc.toFixed(6);
          const sig = result.payment.signature;
          const txInfo = sig ? ` (${explorerUrl(sig)})` : '';
          console.error(`Paid $${amt} USDC to ${result.payment.recipient}${txInfo}`);
          console.log(result.body);
        } else {
          // Non-402 response — just print the body
          console.log(result.body);
        }
      } catch (err: any) {
        output(failure('FETCH_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
