import { Command } from 'commander';
import { getSdk } from '../sdk-init.js';
import { SOLANA_COMPASS_VOTE } from '@solana-compass/sdk';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { isPermitted } from '../core/config-manager.js';
import { assertWithinLimitsFromPrice } from '../core/security.js';
import { SOL_MINT } from '../utils/solana.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import { shortenAddress } from '../utils/solana.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerStakeCommand(program: Command): void {
  const stake = program.command('stake').description('Native SOL staking');

  stake
    .command('list')
    .description('List all stake accounts')
    .option('--wallet <name>', 'Wallet to check')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: accounts, elapsed_ms } = await timed(() => getSdk().stake.getStakeAccounts(wallet.address));

        if (isJsonMode()) {
          const totalClaimable = accounts.reduce((s, a) => s + a.claimableExcess, 0);
          output(success({ wallet: walletName, accounts, totalClaimable }, { elapsed_ms }));
        } else if (accounts.length === 0) {
          console.log('No stake accounts found.');
        } else {
          console.log(table(
            accounts.map(a => ({
              address: shortenAddress(a.address, 6),
              balance: `${a.solBalance.toFixed(4)} SOL${a.claimableExcess > 0 ? ' *' : ''}`,
              status: a.status,
              validator: a.validator ? shortenAddress(a.validator, 6) : '—',
            })),
            [
              { key: 'address', header: 'Stake Account' },
              { key: 'balance', header: 'Balance', align: 'right' },
              { key: 'status', header: 'Status' },
              { key: 'validator', header: 'Validator' },
            ]
          ));

          const claimable = accounts.filter(a => a.claimableExcess > 0);
          if (claimable.length > 0) {
            const total = claimable.reduce((s, a) => s + a.claimableExcess, 0);
            console.log(`\n* ${total.toFixed(6)} SOL claimable MEV across ${claimable.length} account${claimable.length > 1 ? 's' : ''}. Run \`sol stake claim-mev\` to compound.`);
          }
        }
      } catch (err: any) {
        output(failure('STAKE_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canStake')) stake
    .command('new <amount>')
    .description('Create a stake account and delegate to a validator')
    .option('--wallet <name>', 'Wallet to use')
    .option('--validator <vote>', 'Validator vote account (default: Solana Compass)')
    .action(async (amountStr: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        // Transaction limits check
        const prices = await getSdk().price.getPrices([SOL_MINT]);
        const solPrice = prices.get(SOL_MINT);
        assertWithinLimitsFromPrice(solPrice?.priceUsd, amount, 'staking');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const validatorLabel = opts.validator || `Solana Compass (${shortenAddress(SOLANA_COMPASS_VOTE, 7)})`;

        const { result, elapsed_ms } = await timed(() =>
          getSdk().stake.createAndDelegateStake(walletName, amount, opts.validator, {
            fromPriceUsd: solPrice?.priceUsd,
          })
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Staked ${amount} SOL with ${validatorLabel}`);
          console.log(`  Stake account: ${result.stakeAccount}`);
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('STAKE_NEW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canWithdrawStake')) stake
    .command('withdraw <stakeAccount> [amount]')
    .description('Withdraw from a stake account (smart: deactivates if needed, splits for partial)')
    .option('--wallet <name>', 'Wallet to use')
    .option('--force', 'Directly withdraw regardless of state')
    .action(async (stakeAccount: string, amountStr: string | undefined, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const amountSol = amountStr ? parseFloat(amountStr) : undefined;
        if (amountStr !== undefined && (isNaN(amountSol!) || amountSol! <= 0)) {
          throw new Error('Invalid amount');
        }

        const { result, elapsed_ms } = await timed(() =>
          getSdk().stake.withdrawStake(walletName, stakeAccount, amountSol, opts.force)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(result.message);
          if (result.signature) {
            console.log(`  Tx: ${result.explorerUrl}`);
          }
        }
      } catch (err: any) {
        output(failure('STAKE_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canWithdrawStake')) stake
    .command('claim-mev [stakeAccount]')
    .description('Claim MEV tips from stake accounts (default: compound by re-staking)')
    .option('--wallet <name>', 'Wallet to use')
    .option('--withdraw', 'Withdraw to wallet instead of compounding')
    .action(async (stakeAccount: string | undefined, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: results, elapsed_ms } = await timed(() =>
          getSdk().stake.claimMev(walletName, wallet.address, stakeAccount, opts.withdraw)
        );

        if (isJsonMode()) {
          output(success(results, { elapsed_ms }));
        } else {
          for (const r of results) {
            if (r.action === 'compounded') {
              console.log(`Compounded ${r.amountSol.toFixed(6)} SOL from ${shortenAddress(r.stakeAccount, 6)}`);
              console.log(`  New stake account: ${r.newStakeAccount}`);
              console.log(`  Withdraw tx: ${r.withdrawExplorerUrl}`);
              console.log(`  Stake tx: ${r.stakeExplorerUrl}`);
            } else {
              console.log(`Withdrew ${r.amountSol.toFixed(6)} SOL MEV from ${shortenAddress(r.stakeAccount, 6)}`);
              console.log(`  Tx: ${r.withdrawExplorerUrl}`);
            }
          }
          const total = results.reduce((s, r) => s + r.amountSol, 0);
          if (results.length > 1) {
            console.log(`\nTotal: ${total.toFixed(6)} SOL ${results[0].action === 'compounded' ? 'compounded' : 'withdrawn'}`);
          }
        }
      } catch (err: any) {
        output(failure('STAKE_CLAIM_MEV_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
