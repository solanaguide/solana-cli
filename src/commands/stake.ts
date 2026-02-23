import { Command } from 'commander';
import {
  getStakeAccounts,
  createAndDelegateStake,
  withdrawStake,
  SOLANA_COMPASS_VOTE,
} from '../core/stake-service.js';
import { getDefaultWalletName } from '../core/wallet-manager.js';
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
        const walletName = opts.wallet || getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: accounts, elapsed_ms } = await timed(() => getStakeAccounts(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, accounts }, { elapsed_ms }));
        } else if (accounts.length === 0) {
          console.log('No stake accounts found.');
        } else {
          console.log(table(
            accounts.map(a => ({
              address: shortenAddress(a.address, 6),
              balance: `${a.solBalance.toFixed(4)} SOL`,
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
        }
      } catch (err: any) {
        output(failure('STAKE_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  stake
    .command('new <amount>')
    .description('Create a stake account and delegate to a validator')
    .option('--wallet <name>', 'Wallet to use')
    .option('--validator <vote>', 'Validator vote account (default: Solana Compass)')
    .action(async (amountStr: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet || getDefaultWalletName();
        const validatorLabel = opts.validator || `Solana Compass (${shortenAddress(SOLANA_COMPASS_VOTE, 7)})`;

        const { result, elapsed_ms } = await timed(() =>
          createAndDelegateStake(walletName, amount, opts.validator)
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

  stake
    .command('withdraw <stakeAccount> [amount]')
    .description('Withdraw from a stake account (smart: deactivates if needed, splits for partial)')
    .option('--wallet <name>', 'Wallet to use')
    .option('--force', 'Directly withdraw regardless of state')
    .action(async (stakeAccount: string, amountStr: string | undefined, opts) => {
      try {
        const walletName = opts.wallet || getDefaultWalletName();
        const amountSol = amountStr ? parseFloat(amountStr) : undefined;
        if (amountStr !== undefined && (isNaN(amountSol!) || amountSol! <= 0)) {
          throw new Error('Invalid amount');
        }

        const { result, elapsed_ms } = await timed(() =>
          withdrawStake(walletName, stakeAccount, amountSol, opts.force)
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
}
