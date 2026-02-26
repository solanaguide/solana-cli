# Sol CLI — Solana for Humans and LLM Agents

## What This Is

A Solana CLI that reads like English: `sol token swap 50 usdc bonk`, `sol stake new 10`, `sol wallet balance`. Every command has structured `--json` output so LLM agents can drive it programmatically.

## Design Principles

### Natural language commands
Commands should read like what you'd say out loud. Prefer `sol token swap 50 usdc bonk` over `sol swap --from usdc --to bonk --amount 50`. Positional args for the common case, flags for overrides. Think: self documenting features: the example syntax should explain what the function does and how to operate it.

### Model user intent, not on-chain mechanics
Commands map to what the user wants to do, not the underlying Solana instructions. The user wants to "stake" — they don't care that it's create + initialize + delegate. They want to "withdraw" — they don't care about deactivate vs split vs withdraw depending on state. Hide the protocol complexity behind a single verb. Batch multiple on-chain steps into one transaction wherever possible. But do mention the process in help text to avoid too much "magic" — e.g. `sol stake new <amount>` description says "Creates a stake account, funds it and delegates in a single tx".

### Signpost next actions
After output, tell the user what they can do next. `stake list` reminds about claimable MEV. `wallet list` hints at `wallet balance` for full details. Don't leave the user wondering "now what?".

### On-chain first, API keys never
Implement functionality directly via RPC and on-chain programs. Don't require API keys for core features. The Jupiter API is acceptable for swaps (it's free, keyless), but core operations like staking, transfers, and token info should work with just an RPC endpoint.

### Smart defaults, easy overrides
Default validator is Solana Compass. Default wallet is the first one created. Default slippage is 50 bps. Default router is `best`. All overridable with flags. A new user should be able to `sol wallet create && sol stake new 10` without configuring anything beyond an RPC.

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
- For pre-built transactions (Jupiter orders, lend), inject the signer before signing: `Object.assign({}, msg, { feePayer: signer })`.

## Swap Router Abstraction

Swaps go through a pluggable router interface (`src/core/swap-router.ts`). Each router implements `SwapRouter` (getQuote + getSwapTransaction) and self-registers on import.

**Routers:**
- `jupiter` — Jupiter Swap API. Works without API key (falls back to `lite-api.jup.ag`). Always available.
- `dflow` — DFlow Trading API (`quote-api.dflow.net`). Requires API key: `sol config set api.dflowApiKey <key>`.

**Selection:** `--router best` (default) queries all routers in parallel, picks highest output amount. If one fails (e.g. no DFlow key), silently falls back. Use `--router jupiter` or `--router dflow` to force a specific router. Default can be set via `sol config set defaults.router <name>`.

**Adding a new router:** Create `src/core/xxx-router.ts` implementing `SwapRouter`, call `registerRouter()` at module level, and add a side-effect import in `swap-service.ts`.

## DCA & Limit Orders

DCA and limit orders use Jupiter's Recurring and Trigger APIs (`src/core/order-service.ts`). Commands live in `src/commands/token-orders.ts`, registered as subcommands of `sol token`.

**Signing pre-built order transactions:** Jupiter returns unsigned base64 transactions. Use the `signAndExecute()` pattern: decode → decompile → inject signer via `Object.assign({}, msg, { feePayer: signer })` → sign → encode → POST to `/execute`.

**DCA constraints:** $100 total minimum, 2+ orders, $50/order minimum. Intervals: minute, hour, day, week, month.

**Limit order constraints:** $5 minimum order size. Target price is USD price of the output token. We calculate `outputAmount = (inputAmount * inputPriceUsd) / targetPriceUsd`.

**Transaction logging:** Orders log to `transaction_log` with types `dca_create`, `dca_cancel`, `limit_create`, `limit_cancel`.

## Adding a New Command

1. Create or edit a file in `src/commands/` — export `registerXxxCommand(program)`.
2. Register it in `src/index.ts`.
3. Business logic goes in `src/core/` — the command file handles argument parsing and output formatting only.
4. Use `buildAndSendTransaction()` for any on-chain operations.
5. Support `--json` and human output. Include `elapsed_ms` in JSON meta.
6. Add signpost text after output when there's a natural next action.
7. Test with both human and `--json` output.

## Portfolio Integration

`sol portfolio` is the unified view of everything the user holds. Every service that manages assets must feed into it.

### How services expose positions

Each service in `src/core/` that holds user assets should export a function that returns positions for a wallet. These get aggregated by `portfolio-service.ts`. The pattern:

```ts
// In your service (e.g. stake-service.ts, future lend-service.ts):
// Export a function that returns positions for a wallet address.
// portfolio-service.ts will call it and normalize the results.
export async function getStakeAccounts(walletAddress: string): Promise<StakeAccountInfo[]>
```

`portfolio-service.ts` imports each service, calls its position function, and normalizes everything into `PortfolioPosition[]`. No formal interface/registry needed — just import and call. When adding a new asset type (lending, LP), add a few lines to `getPortfolio()`.

### Transaction log as source of truth

`buildAndSendTransaction()` already logs every tx to `transaction_log` with `type`, `from_mint`, `to_mint`, `from_amount`, `to_amount`. This is the raw data for cost basis and P&L calculations. Don't duplicate this — query the transaction log to compute cost basis (e.g. "you swapped 50 USDC for 0.33 SOL → cost basis of that SOL is $151.50/SOL").

When adding new transaction types, always pass meaningful `txType`, `fromMint`/`toMint`, and amount fields to `buildAndSendTransaction()` so the portfolio can reconstruct history.

### Snapshots

Snapshots capture portfolio state at a point in time. The `snapshot_entries` table has `position_type` ('token', 'stake', 'lend', 'lp') and `protocol` fields. When saving a snapshot, include ALL position types — not just tokens.

## Agent Skill Distribution

The CLI is published as a discoverable agent skill via three channels:

- **Claude Code plugin** — `.claude-plugin/marketplace.json` + `plugin.json` at repo root. Auto-discovered from GitHub.
- **skills.sh** — `skills/solana-payments-wallets-trading/SKILL.md` + `references/`. Discovered via npm package.
- **ClawdHub** — same skill directory, published separately.

### Versioning

When bumping the version, update ALL of these in sync:
1. `package.json` → `version`
2. `.claude-plugin/plugin.json` → `version`
3. `.claude-plugin/marketplace.json` → `plugins[0].version`
4. `skills/solana-payments-wallets-trading/SKILL.md` → frontmatter `version`

**Plugin users** get updates when they run `/plugin marketplace update solanaguide-solana-cli` or enable auto-update (disabled by default for third-party marketplaces). If you don't bump the version, the update is skipped — Claude Code treats same-version as unchanged.

**skills.sh users** get updates when they re-run `npx skills add solanaguide/solana-cli` (pulls latest from npm). There's no global update command.

Always `npm publish` after pushing so both channels are in sync.

## Testing

Run `npm test` (Node.js native test runner). For manual end-to-end testing against mainnet, use small amounts (0.01 SOL). The public RPC rate-limits aggressively — set a proper RPC via `sol config set rpc.url`.
