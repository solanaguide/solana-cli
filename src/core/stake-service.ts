import { address, generateKeyPairSigner, type IInstruction } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  STAKE_PROGRAM_ADDRESS,
  getInitializeInstruction,
  getDelegateStakeInstruction,
  getDeactivateInstruction,
  getWithdrawInstruction,
  getSplitInstruction,
} from '@solana-program/stake';
import { getRpc } from './rpc.js';
import { loadSigner } from './wallet-manager.js';
import { verbose } from '../output/formatter.js';
import { lamportsToSol, solToLamports, explorerUrl } from '../utils/solana.js';
import { buildAndSendTransaction, type SendResult } from './transaction.js';

// Solana Compass validator — default recommendation
export const SOLANA_COMPASS_VOTE = 'EARNynHRWg6GfyJCmrrizcZxARB3HVzcaasvNa8kBS72';

const STAKE_ACCOUNT_SIZE = 200n;
const STAKE_HISTORY_SYSVAR = address('SysvarStakeHistory1111111111111111111111111');
const STAKE_CONFIG = address('StakeConfig11111111111111111111111111111111');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

// ── Types ─────────────────────────────────────────────────

export interface StakeAccountInfo {
  address: string;
  lamports: number;
  solBalance: number;
  status: string;
  validator?: string;
  activationEpoch?: number;
  deactivationEpoch?: number;
}

export interface CreateStakeResult {
  stakeAccount: string;
  validator: string;
  amountSol: number;
  signature: string;
  explorerUrl: string;
}

export interface WithdrawStakeResult {
  action: 'deactivated' | 'withdrawn' | 'split+deactivated';
  stakeAccount: string;
  splitAccount?: string;
  amountSol?: number;
  signature?: string;
  explorerUrl?: string;
  message: string;
}

// ── Read operations ───────────────────────────────────────

export async function getStakeAccounts(walletAddress: string): Promise<StakeAccountInfo[]> {
  const rpc = getRpc();
  verbose(`Fetching stake accounts for ${walletAddress}`);

  try {
    const accounts = await rpc.getProgramAccounts(
      address('Stake11111111111111111111111111111111111111'),
      {
        filters: [
          { memcmp: { offset: BigInt(12), bytes: walletAddress as any, encoding: 'base58' } },
        ],
        encoding: 'jsonParsed',
      }
    ).send();

    return accounts.map((acc: any) => {
      const parsed = acc.account.data?.parsed?.info;
      const meta = parsed?.meta;
      const stake = parsed?.stake;
      const lamportVal = Number(acc.account.lamports);

      return {
        address: acc.pubkey,
        lamports: lamportVal,
        solBalance: lamportsToSol(lamportVal),
        status: parsed?.type || 'unknown',
        validator: stake?.delegation?.voter,
        activationEpoch: stake?.delegation?.activationEpoch ? Number(stake.delegation.activationEpoch) : undefined,
        deactivationEpoch: stake?.delegation?.deactivationEpoch ? Number(stake.delegation.deactivationEpoch) : undefined,
      };
    });
  } catch (err) {
    verbose(`Failed to fetch stake accounts: ${err}`);
    return [];
  }
}

// ── Create + delegate ─────────────────────────────────────

export async function createAndDelegateStake(
  walletName: string,
  amountSol: number,
  validatorVote?: string,
): Promise<CreateStakeResult> {
  const rpc = getRpc();
  const signer = await loadSigner(walletName);
  const validator = validatorVote || SOLANA_COMPASS_VOTE;

  // Generate ephemeral keypair for the new stake account
  const stakeAccountSigner = await generateKeyPairSigner();

  // Calculate lamports: rent-exempt minimum + stake amount
  const rentExempt = await rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE).send();
  const stakeLamports = solToLamports(amountSol);
  const totalLamports = rentExempt + stakeLamports;

  verbose(`Creating stake account ${stakeAccountSigner.address}`);
  verbose(`Rent exempt: ${rentExempt}, stake: ${stakeLamports}, total: ${totalLamports}`);

  const instructions: IInstruction[] = [
    // 1. Create account owned by stake program
    getCreateAccountInstruction({
      payer: signer,
      newAccount: stakeAccountSigner,
      lamports: totalLamports,
      space: STAKE_ACCOUNT_SIZE,
      programAddress: STAKE_PROGRAM_ADDRESS,
    }),

    // 2. Initialize: set staker + withdrawer to our wallet
    getInitializeInstruction({
      stake: stakeAccountSigner.address,
      arg0: { staker: signer.address, withdrawer: signer.address },
      arg1: { unixTimestamp: 0, epoch: 0, custodian: SYSTEM_PROGRAM },
    }),

    // 3. Delegate to validator
    getDelegateStakeInstruction({
      stake: stakeAccountSigner.address,
      vote: address(validator),
      stakeHistory: STAKE_HISTORY_SYSVAR,
      unused: STAKE_CONFIG,
      stakeAuthority: signer,
    }),
  ];

  const result = await buildAndSendTransaction(instructions, signer, {
    txType: 'stake',
    walletName,
  });

  return {
    stakeAccount: stakeAccountSigner.address,
    validator,
    amountSol,
    signature: result.signature,
    explorerUrl: result.explorerUrl,
  };
}

// ── Smart withdraw ────────────────────────────────────────

export async function withdrawStake(
  walletName: string,
  stakeAccountAddress: string,
  amountSol?: number,
  force?: boolean,
): Promise<WithdrawStakeResult> {
  const rpc = getRpc();
  const signer = await loadSigner(walletName);
  const stakeAddr = address(stakeAccountAddress);

  // If --force, just withdraw directly
  if (force) {
    return forceWithdraw(signer, stakeAddr, walletName, amountSol);
  }

  // Check stake account status
  const accountInfo = await rpc.getAccountInfo(stakeAddr, { encoding: 'jsonParsed' }).send();
  if (!accountInfo.value) {
    throw new Error(`Stake account ${stakeAccountAddress} not found`);
  }

  const data = accountInfo.value.data as any;
  const stakeType: string = data?.parsed?.type || 'unknown';
  const parsed = data?.parsed?.info;
  const lamportBalance = Number(accountInfo.value.lamports);

  verbose(`Stake account status: ${stakeType}, balance: ${lamportsToSol(lamportBalance)} SOL`);

  // Partial withdrawal → split + deactivate
  if (amountSol !== undefined) {
    return partialWithdraw(signer, stakeAddr, amountSol, walletName, rpc);
  }

  // Full withdrawal — depends on current state
  switch (stakeType) {
    case 'delegated': {
      // Check deactivation epoch
      const deactivationEpoch = parsed?.stake?.delegation?.deactivationEpoch;
      const epochInfo = await rpc.getEpochInfo().send();
      const currentEpoch = Number(epochInfo.epoch);

      if (deactivationEpoch && Number(deactivationEpoch) < Number('18446744073709551615') && Number(deactivationEpoch) <= currentEpoch) {
        // Already deactivated and cooldown passed → withdraw
        return forceWithdraw(signer, stakeAddr, walletName);
      }

      if (deactivationEpoch && Number(deactivationEpoch) < Number('18446744073709551615')) {
        // Deactivating but not ready yet
        return {
          action: 'deactivated',
          stakeAccount: stakeAccountAddress,
          message: `Stake account is deactivating (epoch ${deactivationEpoch}). Current epoch: ${currentEpoch}. Wait for the cooldown to complete, then run:\n  sol stake withdraw ${stakeAccountAddress} --force`,
        };
      }

      // Active → deactivate
      const ix = getDeactivateInstruction({
        stake: stakeAddr,
        stakeAuthority: signer,
      });

      const result = await buildAndSendTransaction([ix], signer, {
        txType: 'stake-deactivate',
        walletName,
      });

      return {
        action: 'deactivated',
        stakeAccount: stakeAccountAddress,
        signature: result.signature,
        explorerUrl: result.explorerUrl,
        message: `Stake account deactivated. Wait for the cooldown epoch to pass, then withdraw:\n  sol stake withdraw ${stakeAccountAddress} --force`,
      };
    }

    case 'initialized': {
      // Not delegated, can withdraw directly
      return forceWithdraw(signer, stakeAddr, walletName);
    }

    default:
      throw new Error(`Unexpected stake account state: "${stakeType}". Use --force to attempt a direct withdraw.`);
  }
}

// ── Force withdraw ────────────────────────────────────────

async function forceWithdraw(
  signer: Awaited<ReturnType<typeof loadSigner>>,
  stakeAddr: ReturnType<typeof address>,
  walletName: string,
  amountSol?: number,
): Promise<WithdrawStakeResult> {
  const rpc = getRpc();

  // If no amount specified, withdraw everything
  let withdrawLamports: bigint;
  if (amountSol !== undefined) {
    withdrawLamports = solToLamports(amountSol);
  } else {
    const accountInfo = await rpc.getAccountInfo(stakeAddr, { encoding: 'base64' }).send();
    if (!accountInfo.value) throw new Error(`Stake account not found`);
    withdrawLamports = accountInfo.value.lamports;
  }

  const ix = getWithdrawInstruction({
    stake: stakeAddr,
    recipient: signer.address,
    stakeHistory: STAKE_HISTORY_SYSVAR,
    withdrawAuthority: signer,
    args: withdrawLamports,
  });

  const result = await buildAndSendTransaction([ix], signer, {
    txType: 'stake-withdraw',
    walletName,
  });

  return {
    action: 'withdrawn',
    stakeAccount: String(stakeAddr),
    amountSol: lamportsToSol(withdrawLamports),
    signature: result.signature,
    explorerUrl: result.explorerUrl,
    message: `Withdrew ${lamportsToSol(withdrawLamports)} SOL from stake account`,
  };
}

// ── Partial withdraw (split + deactivate) ─────────────────

async function partialWithdraw(
  signer: Awaited<ReturnType<typeof loadSigner>>,
  stakeAddr: ReturnType<typeof address>,
  amountSol: number,
  walletName: string,
  rpc: ReturnType<typeof getRpc>,
): Promise<WithdrawStakeResult> {
  const splitLamports = solToLamports(amountSol);

  // Generate ephemeral keypair for the split account
  const splitAccountSigner = await generateKeyPairSigner();

  // Split requires the destination account to exist (system create with 0 lamports, stake program owner)
  const rentExempt = await rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE).send();

  const instructions: IInstruction[] = [
    // Create the split destination account
    getCreateAccountInstruction({
      payer: signer,
      newAccount: splitAccountSigner,
      lamports: rentExempt,
      space: STAKE_ACCOUNT_SIZE,
      programAddress: STAKE_PROGRAM_ADDRESS,
    }),

    // Split desired amount into the new account
    getSplitInstruction({
      stake: stakeAddr,
      splitStake: splitAccountSigner.address,
      stakeAuthority: signer,
      args: splitLamports,
    }),

    // Deactivate the split account so it can be withdrawn later
    getDeactivateInstruction({
      stake: splitAccountSigner.address,
      stakeAuthority: signer,
    }),
  ];

  const result = await buildAndSendTransaction(instructions, signer, {
    txType: 'stake-split',
    walletName,
  });

  return {
    action: 'split+deactivated',
    stakeAccount: String(stakeAddr),
    splitAccount: splitAccountSigner.address,
    amountSol,
    signature: result.signature,
    explorerUrl: result.explorerUrl,
    message: `Split ${amountSol} SOL into ${splitAccountSigner.address} and deactivated it. After the cooldown epoch, withdraw with:\n  sol stake withdraw ${splitAccountSigner.address} --force`,
  };
}
