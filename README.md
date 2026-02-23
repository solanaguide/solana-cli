# sol — Solana for Humans and LLM Agents

A Solana CLI that reads like English. Every command has structured `--json` output so LLM agents like Claude Code can drive it programmatically — managing wallets, executing swaps, staking, lending, and tracking portfolios without ever touching raw transactions.

```bash
sol token swap 50 usdc bonk          # Swap via Jupiter
sol stake new 10                      # Stake SOL in one command
sol lend deposit 100 usdc             # Earn yield on Kamino
sol portfolio                         # See everything you hold
```

---

## Why This Exists

Solana has great infrastructure but terrible UX for automation. An LLM agent that wants to "swap 50 USDC for BONK" shouldn't need to construct transaction messages, manage blockhashes, or parse binary account data. **sol** wraps all of that behind natural-language commands with structured JSON responses:

```bash
$ sol token swap 50 usdc bonk --json
{
  "ok": true,
  "data": {
    "inputToken": "USDC",
    "outputToken": "BONK",
    "inputAmount": 50,
    "outputAmount": 3842519.52,
    "signature": "4xK9...",
    "explorerUrl": "https://solscan.io/tx/4xK9..."
  },
  "meta": { "elapsed_ms": 1823 }
}
```

No API keys required. No SDK integration. Just commands and JSON.

---

## Install

```bash
git clone <repo> && cd sol
npm install
npm link          # makes `sol` available globally
```

Requires Node.js >= 20.

### First-time setup

```bash
sol config set rpc.url https://api.mainnet-beta.solana.com
sol wallet create
```

Use a dedicated RPC endpoint for production — the public one rate-limits aggressively. Helius, Triton, or QuickNode all offer free tiers.

---

## Commands

### wallet — Create, import, and manage Solana keypairs

```bash
sol wallet create                             # New wallet, auto-named
sol wallet create --name trading --count 3    # Batch-create 3 wallets
sol wallet list                               # List all wallets with SOL balances
sol wallet balance                            # Full token balances + USD values
sol wallet balance trading                    # Balance for a specific wallet

sol wallet import --solana-cli                # Import from ~/.config/solana/id.json
sol wallet import ./keypair.json --name cold  # Import from file
sol wallet export main                        # Show key file path
sol wallet remove old-wallet                  # Remove from registry

sol wallet label main --add trading           # Tag wallets for organization
sol wallet history                            # Recent transaction activity
sol wallet history --type swap --limit 5      # Filtered
sol wallet fund --amount 100                  # Generate fiat onramp URL (Transak)
```

Wallets are stored locally as key files. The first wallet created becomes the default for all commands. Override with `--wallet <name>` on any command.

### token — Prices, swaps, transfers, and account management

```bash
sol token price sol                           # Current SOL price
sol token price sol usdc bonk                 # Multiple prices at once
sol token info bonk                           # Token metadata (mint, decimals)
sol token list                                # All tokens in your wallet
sol token sync                                # Refresh token metadata cache

sol token swap 50 usdc bonk                   # Swap via Jupiter
sol token swap 1.5 sol usdc --slippage 100    # 1% slippage tolerance
sol token swap 50 usdc bonk --quote-only      # Preview without executing

sol token send 2 sol GkX...abc                # Send SOL to an address
sol token burn bonk --all                     # Burn all of a token
sol token close --all --yes                   # Close empty accounts, reclaim rent
```

Swaps use Jupiter's aggregator — best price across all Solana DEXes, no API key needed. Every swap is logged with cost-basis prices for portfolio tracking.

### Token resolution

Anywhere a command takes a token, you can use a **symbol** (`sol`, `usdc`, `bonk`) or a **mint address** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). Resolution works in three steps:

1. **Hardcoded well-known list** — 15 major tokens (SOL, USDC, USDT, JUP, BONK, mSOL, jitoSOL, bSOL, ETH, wBTC, PYTH, JTO, WEN, RNDR, JLP) resolve instantly offline. These are immune to spoofing.

2. **Local cache** — Previously resolved tokens are cached in SQLite with a 24-hour TTL. Populated by prior lookups and `sol token sync`.

3. **Jupiter Token API** — If not cached, the CLI searches Jupiter's token database. Results are ranked by liquidity and trading volume, so `usdc` returns the real USDC — not a scam token with the same symbol. The result is cached for next time.

**For unfamiliar tokens, verify before transacting:**

```bash
sol token info peng                           # Check the resolved mint address
sol token swap 50 usdc EPjFW...1v --quote-only  # Use the mint address directly
```

Using a mint address bypasses symbol search entirely — useful when you know exactly which token you want, or when dealing with tokens that share a ticker. Agents should prefer mint addresses for safety when operating autonomously.

### stake — Native SOL staking with MEV compounding

```bash
sol stake new 10                              # Stake 10 SOL (default: Solana Compass)
sol stake new 5 --validator DPm...xyz         # Stake with a specific validator
sol stake list                                # All stake accounts + claimable MEV
sol stake claim-mev                           # Compound MEV tips (re-stake)
sol stake claim-mev --withdraw                # Withdraw MEV to wallet instead
sol stake withdraw 7gK...abc                  # Smart withdraw (handles deactivation)
```

Creates a stake account, funds it, and delegates — all in a single transaction. The CLI handles the multi-step Solana staking process so you don't have to.

### lend — Lending and borrowing on Kamino Finance

```bash
sol lend rates sol                            # Deposit/borrow APY for SOL
sol lend rates usdc                           # USDC rates

sol lend deposit 100 usdc                     # Deposit USDC to earn yield
sol lend deposit 5 sol                        # Deposit SOL as collateral
sol lend withdraw 50 usdc                     # Partial withdrawal
sol lend withdraw max sol                     # Withdraw entire deposit

sol lend borrow 500 usdc --collateral sol     # Borrow against collateral
sol lend repay 250 usdc                       # Partial repay
sol lend repay max usdc                       # Repay full outstanding debt

sol lend positions                            # All deposits, borrows, health factor
```

Positions include real-time APY, USD values, and health factor monitoring. The CLI warns when health factor drops below 1.1.

### portfolio — Unified view across all positions

```bash
sol portfolio                                 # Everything: tokens, stakes, lending
sol portfolio --wallet trading                # Single wallet view

sol portfolio snapshot                        # Save current state
sol portfolio snapshot --label "pre-trade"    # With a label
sol portfolio history                         # List all snapshots

sol portfolio compare                         # Diff vs latest snapshot
sol portfolio compare 3                       # Diff vs snapshot #3
sol portfolio pnl                             # P&L since first snapshot
sol portfolio pnl --since 5                   # P&L since snapshot #5
```

The portfolio aggregates tokens, staked SOL, and Kamino lending positions across all wallets. Snapshots enable tracking changes over time — useful for agents that need to measure the impact of their actions.

### config — Persistent settings

```bash
sol config set rpc.url https://my-rpc.com     # Set RPC endpoint
sol config get rpc.url                         # Read a value
sol config list                                # Show all settings
sol config path                                # Config file location
```

### Other commands

```bash
sol network                                   # Epoch, TPS, inflation, staking APY
sol tx 4xK9...abc                             # Look up a transaction by signature
```

---

## For LLM Agents

Every command supports `--json` for structured output. Responses follow a consistent envelope:

**Success:**
```json
{
  "ok": true,
  "data": { ... },
  "meta": { "elapsed_ms": 450 }
}
```

**Error:**
```json
{
  "ok": false,
  "error": "SWAP_FAILED",
  "message": "Insufficient SOL balance"
}
```

Error codes are predictable `UPPER_SNAKE_CASE` identifiers (`WALLET_CREATE_FAILED`, `LEND_DEPOSIT_FAILED`, etc.). An agent can branch on `ok`, read `data` for results, and use `error` codes for programmatic error handling without parsing human text.

### Agent workflow example

A Claude Code agent managing a DeFi portfolio might run:

```bash
# 1. Check what we're working with
sol wallet balance --json
sol portfolio --json

# 2. Sell some BONK for USDC
sol token swap 1000000 bonk usdc --json

# 3. Put idle USDC to work earning yield
sol lend deposit 100 usdc --json

# 4. Stake idle SOL
sol stake new 5 --json

# 5. Verify final state and snapshot for tracking
sol portfolio --json
sol portfolio snapshot --label "rebalanced" --json
```

Each step returns structured data the agent can parse and act on. No web scraping, no API key management, no transaction construction.

### What agents get for free

- **Wallet management** — Create and fund wallets without touching key files
- **Token resolution** — Say `sol` or `usdc` instead of mint addresses
- **Transaction handling** — Automatic retries, blockhash management, confirmation polling
- **Cost-basis tracking** — Every swap is logged with USD prices at execution time
- **Portfolio snapshots** — Track P&L across sessions without external databases
- **Error classification** — Structured errors distinguish transient failures (retry) from terminal ones (stop)

---

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output |
| `--wallet <name>` | Override default wallet |
| `--rpc <url>` | Override RPC endpoint |
| `--verbose` | Show debug logging |

These work on every command: `sol --json --wallet trading token swap 50 usdc bonk`

## RPC Resolution

The CLI resolves an RPC endpoint in this order:

1. `--rpc` flag
2. `SOL_RPC_URL` environment variable
3. `~/.sol/config.toml` → `rpc.url`
4. Solana CLI config (`solana config get`)
5. Public mainnet RPC (with warning)

## Data Storage

All data lives in `~/.sol/`:

| Path | Contents |
|------|----------|
| `config.toml` | Configuration (TOML) |
| `data.db` | SQLite — wallets, token cache, transaction log, snapshots |
| `wallets/*.json` | Keypair files (Solana CLI format, chmod 600) |

The transaction log is the source of truth for cost basis and P&L — every swap, transfer, deposit, and withdrawal is recorded with USD prices at the time of execution.

---

## Architecture

- **Runtime**: Node.js via `tsx` — no build step needed
- **CLI framework**: commander.js
- **Solana SDK**: `@solana/kit` v2
- **Swaps**: Jupiter REST API (no SDK, no API key)
- **Lending**: Kamino Finance via `@kamino-finance/klend-sdk`
- **Prices**: Jupiter Price API with CoinGecko fallback
- **Database**: SQLite via `better-sqlite3` (WAL mode)
- **Config**: TOML via `smol-toml`

```
src/
  index.ts              # CLI entry point, global flags
  commands/             # One file per command group
  core/                 # Business logic (wallet-manager, swap-service, etc.)
  db/                   # SQLite with migration runner
  output/               # JSON envelope + table/portfolio renderers
  utils/                # Solana helpers, token list, retry logic
```

## Security

- Key files are plain JSON (Solana CLI compatible), stored with `chmod 600`
- Private keys are never logged or printed to stdout
- `wallet export` returns the file path, not the key contents
- All transactions are logged to SQLite for audit
- Swap/send commands show details and prompt before executing (unless `--yes`)

## License

MIT
