import { address, generateKeyPairSigner, type Instruction } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  STAKE_PROGRAM_ADDRESS,
  getInitializeInstruction,
  getDelegateStakeInstruction,
  getDeactivateInstruction,
  getWithdrawInstruction,
  getSplitInstruction,
} from '@solana-program/stake';
import { lamportsToSol, solToLamports, explorerUrl } from '../utils/solana.js';
import type { SolContext, SendResult } from '../types.js';
import type { TransactionService } from './transaction-service.js';

export const SOLANA_COMPASS_VOTE = 'EARNynHRWg6GfyJCmrrizcZxARB3HVzcaasvNa8kBS72';

const STAKE_ACCOUNT_SIZE = 200n;
const STAKE_HISTORY_SYSVAR = address('SysvarStakeHistory1111111111111111111111111');
const STAKE_CONFIG = address('StakeConfig11111111111111111111111111111111');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

export interface StakeAccountInfo {
  address: string;
  lamports: number;
  solBalance: number;
  status: string;
  validator?: string;
  activationEpoch?: number;
  deactivationEpoch?: number;
  claimableExcess: number;
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

export interface ClaimMevResult {
  action: 'compounded' | 'withdrawn';
  stakeAccount: string;
  validator?: string;
  amountSol: number;
  withdrawSignature: string;
  withdrawExplorerUrl: string;
  newStakeAccount?: string;
  stakeSignature?: string;
  stakeExplorerUrl?: string;
}

export interface StakeService {
  getStakeAccounts(walletAddress: string): Promise<StakeAccountInfo[]>;
  createAndDelegateStake(
    walletName: string,
    amountSol: number,
    validatorVote?: string,
    opts?: { fromPriceUsd?: number },
  ): Promise<CreateStakeResult>;
  withdrawStake(walletName: string, stakeAccountAddress: string, amountSol?: number, force?: boolean): Promise<WithdrawStakeResult>;
  claimMev(walletName: string, walletAddress: string, stakeAccountAddress?: string, withdrawOnly?: boolean): Promise<ClaimMevResult[]>;
}

export function createStakeService(ctx: SolContext, tx: TransactionService): StakeService {
  const { rpc, logger, signer } = ctx;

  async function getStakeAccounts(walletAddress: string): Promise<StakeAccountInfo[]> {
    logger.verbose(`Fetching stake accounts for ${walletAddress}`);

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
        const stakeType = acc.account.data?.parsed?.type;
        const meta = parsed?.meta;
        const stake = parsed?.stake;
        const lamportVal = Number(acc.account.lamports);

        let claimableExcess = 0;
        if (stakeType === 'delegated' && meta && stake?.delegation) {
          const rentExemptReserve = BigInt(meta.rentExemptReserve || 0);
          const delegatedStake = BigInt(stake.delegation.stake || 0);
          const excess = BigInt(lamportVal) - rentExemptReserve - delegatedStake;
          if (excess > 0n) claimableExcess = lamportsToSol(Number(excess));
        }

        return {
          address: acc.pubkey,
          lamports: lamportVal,
          solBalance: lamportsToSol(lamportVal),
          status: stakeType || 'unknown',
          validator: stake?.delegation?.voter,
          activationEpoch: stake?.delegation?.activationEpoch ? Number(stake.delegation.activationEpoch) : undefined,
          deactivationEpoch: stake?.delegation?.deactivationEpoch ? Number(stake.delegation.deactivationEpoch) : undefined,
          claimableExcess,
        };
      });
    } catch (err) {
      logger.verbose(`Failed to fetch stake accounts: ${err}`);
      return [];
    }
  }

  async function createAndDelegateStake(
    walletName: string,
    amountSol: number,
    validatorVote?: string,
    opts?: { fromPriceUsd?: number },
  ): Promise<CreateStakeResult> {
    const payer = await signer.getSigner(walletName);
    const validator = validatorVote || SOLANA_COMPASS_VOTE;

    const stakeAccountSigner = await generateKeyPairSigner();

    const rentExempt = await rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE).send();
    const stakeLamports = solToLamports(amountSol);
    const totalLamports = rentExempt + stakeLamports;

    logger.verbose(`Creating stake account ${stakeAccountSigner.address}`);
    logger.verbose(`Rent exempt: ${rentExempt}, stake: ${stakeLamports}, total: ${totalLamports}`);

    const instructions: Instruction[] = [
      getCreateAccountInstruction({
        payer,
        newAccount: stakeAccountSigner,
        lamports: totalLamports,
        space: STAKE_ACCOUNT_SIZE,
        programAddress: STAKE_PROGRAM_ADDRESS,
      }),
      getInitializeInstruction({
        stake: stakeAccountSigner.address,
        arg0: { staker: payer.address, withdrawer: payer.address },
        arg1: { unixTimestamp: 0, epoch: 0, custodian: SYSTEM_PROGRAM },
      }),
      getDelegateStakeInstruction({
        stake: stakeAccountSigner.address,
        vote: address(validator),
        stakeHistory: STAKE_HISTORY_SYSVAR,
        unused: STAKE_CONFIG,
        stakeAuthority: payer,
      }),
    ];

    const result = await tx.buildAndSendTransaction(instructions, payer, {
      txType: 'stake',
      walletName,
      fromMint: 'So11111111111111111111111111111111111111112',
      fromAmount: String(stakeLamports),
      fromPriceUsd: opts?.fromPriceUsd,
    });

    return {
      stakeAccount: stakeAccountSigner.address,
      validator,
      amountSol,
      signature: result.signature,
      explorerUrl: result.explorerUrl,
    };
  }

  async function forceWithdraw(
    payerSigner: Awaited<ReturnType<typeof signer.getSigner>>,
    stakeAddr: ReturnType<typeof address>,
    walletName: string,
    amountSol?: number,
  ): Promise<WithdrawStakeResult> {
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
      recipient: payerSigner.address,
      stakeHistory: STAKE_HISTORY_SYSVAR,
      withdrawAuthority: payerSigner,
      args: withdrawLamports,
    });

    const result = await tx.buildAndSendTransaction([ix], payerSigner, {
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

  async function partialWithdraw(
    payerSigner: Awaited<ReturnType<typeof signer.getSigner>>,
    stakeAddr: ReturnType<typeof address>,
    amountSol: number,
    walletName: string,
  ): Promise<WithdrawStakeResult> {
    const splitLamports = solToLamports(amountSol);
    const splitAccountSigner = await generateKeyPairSigner();
    const rentExempt = await rpc.getMinimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE).send();

    const instructions: Instruction[] = [
      getCreateAccountInstruction({
        payer: payerSigner,
        newAccount: splitAccountSigner,
        lamports: rentExempt,
        space: STAKE_ACCOUNT_SIZE,
        programAddress: STAKE_PROGRAM_ADDRESS,
      }),
      getSplitInstruction({
        stake: stakeAddr,
        splitStake: splitAccountSigner.address,
        stakeAuthority: payerSigner,
        args: splitLamports,
      }),
      getDeactivateInstruction({
        stake: splitAccountSigner.address,
        stakeAuthority: payerSigner,
      }),
    ];

    const result = await tx.buildAndSendTransaction(instructions, payerSigner, {
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

  async function withdrawStake(
    walletName: string,
    stakeAccountAddress: string,
    amountSol?: number,
    force?: boolean,
  ): Promise<WithdrawStakeResult> {
    const payerSigner = await signer.getSigner(walletName);
    const stakeAddr = address(stakeAccountAddress);

    if (force) {
      return forceWithdraw(payerSigner, stakeAddr, walletName, amountSol);
    }

    const accountInfo = await rpc.getAccountInfo(stakeAddr, { encoding: 'jsonParsed' }).send();
    if (!accountInfo.value) {
      throw new Error(`Stake account ${stakeAccountAddress} not found`);
    }

    const data = accountInfo.value.data as any;
    const stakeType: string = data?.parsed?.type || 'unknown';
    const parsed = data?.parsed?.info;
    const lamportBalance = Number(accountInfo.value.lamports);

    logger.verbose(`Stake account status: ${stakeType}, balance: ${lamportsToSol(lamportBalance)} SOL`);

    if (amountSol !== undefined) {
      return partialWithdraw(payerSigner, stakeAddr, amountSol, walletName);
    }

    switch (stakeType) {
      case 'delegated': {
        const deactivationEpoch = parsed?.stake?.delegation?.deactivationEpoch;
        const epochInfo = await rpc.getEpochInfo().send();
        const currentEpoch = Number(epochInfo.epoch);

        if (deactivationEpoch && Number(deactivationEpoch) < Number('18446744073709551615') && Number(deactivationEpoch) <= currentEpoch) {
          return forceWithdraw(payerSigner, stakeAddr, walletName);
        }

        if (deactivationEpoch && Number(deactivationEpoch) < Number('18446744073709551615')) {
          return {
            action: 'deactivated',
            stakeAccount: stakeAccountAddress,
            message: `Stake account is deactivating (epoch ${deactivationEpoch}). Current epoch: ${currentEpoch}. Wait for the cooldown to complete, then run:\n  sol stake withdraw ${stakeAccountAddress} --force`,
          };
        }

        const ix = getDeactivateInstruction({
          stake: stakeAddr,
          stakeAuthority: payerSigner,
        });

        const result = await tx.buildAndSendTransaction([ix], payerSigner, {
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
        return forceWithdraw(payerSigner, stakeAddr, walletName);
      }

      default:
        throw new Error(`Unexpected stake account state: "${stakeType}". Use --force to attempt a direct withdraw.`);
    }
  }

  async function claimMev(
    walletName: string,
    walletAddress: string,
    stakeAccountAddress?: string,
    withdrawOnly?: boolean,
  ): Promise<ClaimMevResult[]> {
    const payerSigner = await signer.getSigner(walletName);

    let targets: StakeAccountInfo[];
    if (stakeAccountAddress) {
      const all = await getStakeAccounts(walletAddress);
      const match = all.find(a => a.address === stakeAccountAddress);
      if (!match) throw new Error(`Stake account ${stakeAccountAddress} not found`);
      if (match.claimableExcess <= 0) throw new Error('No claimable MEV on this account');
      targets = [match];
    } else {
      const all = await getStakeAccounts(walletAddress);
      targets = all.filter(a => a.claimableExcess > 0);
      if (targets.length === 0) throw new Error('No claimable MEV across any stake accounts');
    }

    const results: ClaimMevResult[] = [];

    for (const target of targets) {
      const stakeAddr = address(target.address);
      const excessLamports = solToLamports(target.claimableExcess);

      logger.verbose(`Claiming ${target.claimableExcess} SOL MEV from ${target.address}`);

      const withdrawIx = getWithdrawInstruction({
        stake: stakeAddr,
        recipient: payerSigner.address,
        stakeHistory: STAKE_HISTORY_SYSVAR,
        withdrawAuthority: payerSigner,
        args: excessLamports,
      });

      const withdrawResult = await tx.buildAndSendTransaction([withdrawIx], payerSigner, {
        txType: 'mev-claim',
        walletName,
      });

      if (withdrawOnly) {
        results.push({
          action: 'withdrawn',
          stakeAccount: target.address,
          validator: target.validator,
          amountSol: target.claimableExcess,
          withdrawSignature: withdrawResult.signature,
          withdrawExplorerUrl: withdrawResult.explorerUrl,
        });
      } else {
        const stakeResult = await createAndDelegateStake(
          walletName,
          target.claimableExcess,
          target.validator,
        );

        results.push({
          action: 'compounded',
          stakeAccount: target.address,
          validator: target.validator,
          amountSol: target.claimableExcess,
          withdrawSignature: withdrawResult.signature,
          withdrawExplorerUrl: withdrawResult.explorerUrl,
          newStakeAccount: stakeResult.stakeAccount,
          stakeSignature: stakeResult.signature,
          stakeExplorerUrl: stakeResult.explorerUrl,
        });
      }
    }

    return results;
  }

  return { getStakeAccounts, createAndDelegateStake, withdrawStake, claimMev };
}
