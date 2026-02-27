import { address, type Instruction } from '@solana/kit';
import { getRpc } from './rpc.js';
import { verbose } from '../output/formatter.js';

// ── Kamino Lending constants ─────────────────────────────────

export const KLEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
export const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

// Slot duration used by klend-sdk for APY calculations
export const RECENT_SLOT_DURATION_MS = 400;

// ── Type bridge (kit v2 ↔ klend-sdk's kit v3) ───────────────
//
// klend-sdk v7.x uses @solana/kit v3 types internally. Our codebase
// uses kit v2. The runtime shapes are identical (Address is a branded
// string, Rpc has the same methods, Instruction has programAddress +
// accounts + data). These helpers centralise the casts so
// lend-service.ts stays clean.

/** Our kit v2 RPC, cast for klend-sdk consumption. */
export function getKaminoRpc(): any {
  return getRpc();
}

/** Kit v2 address string, cast for klend-sdk. */
export function kAddress(addr: string): any {
  return addr;
}

/** Cast a kit v2 KeyPairSigner to klend-sdk's TransactionSigner. */
export function kSigner(signer: any): any {
  return signer;
}

/**
 * Convert klend-sdk Instruction[] to kit v2 Instruction[].
 * The shapes are identical at runtime — this is a type-level bridge.
 */
export function toV2Instructions(ixs: any[]): Instruction[] {
  return ixs as Instruction[];
}

/** Fetch current slot as bigint (klend-sdk expects Slot = bigint). */
export async function getCurrentSlot(): Promise<bigint> {
  const slot = await getRpc().getSlot().send();
  return BigInt(slot);
}
