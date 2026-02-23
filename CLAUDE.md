# Sol CLI — Solana for Humans and LLM Agents

## What This Is

A Solana CLI that reads like English: `sol token swap 50 usdc bonk`, `sol stake new 10`, `sol wallet balance`. Every command has structured `--json` output so LLM agents can drive it programmatically.

## Design Principles

### Natural language commands
Commands should read like what you'd say out loud. Prefer `sol token swap 50 usdc bonk` over `sol swap --from usdc --to bonk --amount 50`. Positional args for the common case, flags for overrides.

### Model user intent, not on-chain mechanics
Commands map to what the user wants to do, not the underlying Solana instructions. The user wants to "stake" — they don't care that it's create + initialize + delegate. They want to "withdraw" — they don't care about deactivate vs split vs withdraw depending on state. Hide the protocol complexity behind a single verb. Batch multiple on-chain steps into one transaction wherever possible. But do mention the process in help text to avoid too much "magic" — e.g. `sol stake new <amount>` description says "Creates a stake account, funds it and delegates in a single tx".

### Signpost next actions
After output, tell the user what they can do next. `stake list` reminds about claimable MEV. `wallet list` hints at `wallet balance` for full details. Don't leave the user wondering "now what?".

### On-chain first, API keys never
Implement functionality directly via RPC and on-chain programs. Don't require API keys for core features. The Jupiter API is acceptable for swaps (it's free, keyless), but core operations like staking, transfers, and token info should work with just an RPC endpoint.

### Smart defaults, easy overrides
Default validator is Solana Compass. Default wallet is the first one created. Default slippage is 50 bps. All overridable with flags. A new user should be able to `sol wallet create && sol stake new 10` without configuring anything beyond an RPC.

## Architecture

```
src/
  index.ts              Commander entry, global flags (--json, --rpc, --verbose, --wallet)
  commands/             One file per command group, exports registerXxxCommand()
  core/                 Business logic services (pure functions, no classes)
  db/                   SQLite with migration runner, one repo per table
  output/               JSON envelope (CommandResult<T>) and ASCII table renderer
  utils/                Solana helpers, well-known tokens, retry/rate-limit
bin/sol.mjs             Node.js shim (execFileSync with tsx --import)
```

## Code Conventions

### Imports
- ES modules with `.js` extensions on all local imports
- Node builtins use `node:` prefix: `import { join } from 'node:path'`
- Type-only imports: `import { type IInstruction } from '@solana/kit'`

### Output — always dual-mode
Every command MUST handle both human and JSON output:
```ts
if (isJsonMode()) {
  output(success(data, { elapsed_ms }));
} else {
  console.log('human-readable text');
}
```
JSON uses the `CommandResult<T>` envelope: `{ ok, data, error, message, meta: { elapsed_ms } }`.

### Error handling
```ts
try {
  // command logic
} catch (err: any) {
  output(failure('COMMAND_ACTION_FAILED', err.message));
  process.exitCode = 1;
}
```
Error codes are `UPPER_SNAKE_CASE`. Format: `NOUN_VERB_FAILED`.

### Transactions
Build with `buildAndSendTransaction(instructions, payer, opts)` from `src/core/transaction.ts`. It handles blockhash, signing, encoding, sending, confirmation polling, retry with error classification, and tx logging. Don't reimplement this.

### Timing
Wrap async work in `timed()` to get `elapsed_ms` for the JSON envelope:
```ts
const { result, elapsed_ms } = await timed(() => doWork());
```

### Database
- SQLite via better-sqlite3, WAL mode
- Repos in `src/db/repos/` — snake_case column names matching DB schema
- Migrations in `src/db/migrations/`

### Naming
- Files: kebab-case (`stake-service.ts`, `wallet-repo.ts`)
- Functions/variables: camelCase
- Interfaces/types: PascalCase
- Constants: UPPER_SNAKE_CASE
- CLI flags: kebab-case (`--quote-only`), camelCase in code (`opts.quoteOnly`)
- Error codes: `UPPER_SNAKE_CASE`

## Solana / @solana/kit v2 Notes

- Keys are non-extractable by default. For exportable keypairs: `createKeyPairFromPrivateKeyBytes(bytes, true)`.
- Ephemeral keypairs (e.g. new stake accounts): use `generateKeyPairSigner()` from `@solana/kit`.
- Transaction pipeline: `pipe(createTransactionMessage, setFeePayer, setBlockhash, appendInstructions)` then `signTransactionMessageWithSigners` then `getBase64EncodedWireTransaction`.
- All instruction builders come from `@solana-program/*` packages (system, token, stake).
- Jupiter swap txs arrive pre-built as base64 — decode, sign, re-encode, send via `sendEncodedTransaction()`.

## Adding a New Command

1. Create or edit a file in `src/commands/` — export `registerXxxCommand(program)`.
2. Register it in `src/index.ts`.
3. Business logic goes in `src/core/` — the command file handles argument parsing and output formatting only.
4. Use `buildAndSendTransaction()` for any on-chain operations.
5. Support `--json` and human output. Include `elapsed_ms` in JSON meta.
6. Add signpost text after output when there's a natural next action.
7. Test with both human and `--json` output.

## Testing

Run `npm test` (Node.js native test runner). For manual end-to-end testing against mainnet, use small amounts (0.01 SOL). The public RPC rate-limits aggressively — set a proper RPC via `sol config set rpc.url`.
