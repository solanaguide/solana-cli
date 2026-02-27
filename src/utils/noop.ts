import { address, type Instruction } from '@solana/kit';

const NOOP_PROGRAM_ID = address('C1ixy1NHaoibKyXJC5YGU1DU63k3r46ECsae9LdGa5sq');

export function createNoopInstruction(): Instruction {
  return {
    programAddress: NOOP_PROGRAM_ID,
    accounts: [],
    data: new Uint8Array([]),
  };
}
