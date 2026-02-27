import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { type Instruction, type AccountMeta, address } from '@solana/kit';
import { getRpcUrl } from '../rpc.js';

// ── v1 Connection factory ────────────────────────────────

let cachedConnection: Connection | null = null;
let cachedConnectionUrl: string | null = null;

export function getV1Connection(): Connection {
  const url = getRpcUrl();
  if (cachedConnection && cachedConnectionUrl === url) return cachedConnection;
  cachedConnection = new Connection(url, 'confirmed');
  cachedConnectionUrl = url;
  return cachedConnection;
}

// ── Wallet shim ──────────────────────────────────────────
//
// MarginFi SDK needs a Wallet with signTransaction + publicKey.
// For write ops we extract instructions and sign via our v2 pipeline,
// so the wallet never actually signs. We just need the correct publicKey
// so the SDK derives the right accounts (obligation PDAs, ATAs, etc.).

export class DummyWallet {
  readonly publicKey: PublicKey;
  constructor(address: string) {
    this.publicKey = new PublicKey(address);
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    throw new Error('DummyWallet cannot sign — use instruction builders and sign via v2 pipeline');
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    throw new Error('DummyWallet cannot sign — use instruction builders and sign via v2 pipeline');
  }
}

// ── Instruction conversion ───────────────────────────────

/**
 * Convert v1 TransactionInstruction[] to v2 Instruction[].
 * Maps account roles to the kit v2 AccountMeta format.
 */
export function toV2Instructions(ixs: TransactionInstruction[]): Instruction[] {
  return ixs.map(ix => ({
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map(key => ({
      address: address(key.pubkey.toBase58()),
      role: accountRole(key.isSigner, key.isWritable),
    } as AccountMeta)),
    data: ix.data,
  }));
}

function accountRole(isSigner: boolean, isWritable: boolean): number {
  // kit v2 AccountRole enum: 0=READONLY, 1=WRITABLE, 2=READONLY_SIGNER, 3=WRITABLE_SIGNER
  if (isSigner && isWritable) return 3;
  if (isSigner) return 2;
  if (isWritable) return 1;
  return 0;
}
