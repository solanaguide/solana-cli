# sol — Solana for Humans and LLM Agents

A command-line tool that lets you work with Solana the way you'd describe it out loud. Pay people, buy and sell tokens, stake, lend, and track your portfolio — instead of constructing transactions and managing program instructions, you say what you want. Keys live locally on disk. No API keys, no private key env vars.

```bash
# Set up
sol wallet create --name "ClawdBot"

# Transfer some SOL to the agent wallet, then:

# Check balance
sol wallet balance

# Swap 50 USDC for BONK
sol token swap 50 usdc bonk

# Stake idle SOL
sol stake new 10

# Deposit USDC to earn yield (auto-picks best rate across protocols)
sol lend deposit 100 usdc

# See everything you hold
sol portfolio

# Snapshot for tracking over time
sol portfolio snapshot --label "post-rebalance"
```

---

## Install

```bash
npm install -g @solana-compass/cli
```

Or run without installing:

```bash
npx @solana-compass/cli@latest wallet list
```

Requires Node.js >= 20.

### Install as an Agent Skill

Sol CLI is available as a discoverable skill for Claude Code and other LLM agents:

```bash
# Claude Code — add the marketplace, then install the plugin
/plugin marketplace add solanaguide/solana-cli
/plugin install solana-payments-wallets-trading@solanaguide-solana-cli

# skills.sh
npx skills add solanaguide/solana-cli
```

Once installed, the agent can use Sol commands directly when you ask it to send crypto, trade tokens, check balances, stake, lend, or track portfolio performance.

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

sol wallet set-default trading                 # Change the active wallet
sol wallet label main --add trading           # Tag wallets for organization
sol wallet history                            # Recent transaction activity
sol wallet history --type swap --limit 5      # Filtered
```

Wallets are stored locally as key files. The first wallet created becomes the default for all commands. Change it with `sol wallet set-default <name>`, or override per-command with `--wallet <name-or-address>`.

### token — Prices, swaps, transfers, and account management

```bash
sol token browse trending                    # Discover trending tokens
sol token browse top-traded --interval 24h   # Most traded over 24h
sol token browse lst                         # Liquid staking tokens

sol token price sol                           # Current SOL price
sol token price sol usdc bonk                 # Multiple prices at once
sol token info bonk                           # Token metadata (mint, decimals)
sol token list                                # All tokens in your wallet
sol token sync                                # Refresh token metadata cache

sol token swap 50 usdc bonk                   # Swap via Jupiter
sol token swap 1.5 sol usdc --slippage 100    # 1% slippage tolerance
sol token swap 50 usdc bonk --quote-only      # Preview without executing

sol token swap 5 usdc sol --wallet backup      # Swap from a specific wallet
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

### lend — Multi-protocol lending and borrowing

Aggregates rates across Kamino, MarginFi, Drift, Jupiter Lend, and Loopscale. Auto-picks the best rate, or use `--protocol` to target a specific one.

```bash
sol lend rates usdc                           # Compare rates across all protocols
sol lend rates sol --protocol kamino          # Rates for a specific protocol

sol lend deposit 100 usdc                     # Auto-picks best deposit rate
sol lend deposit 5 sol --protocol marginfi    # Deposit into a specific protocol
sol lend withdraw 50 usdc                     # Partial withdrawal
sol lend withdraw max sol                     # Withdraw entire deposit

sol lend borrow 500 usdc --collateral sol     # Borrow against collateral
sol lend repay 250 usdc                       # Partial repay
sol lend repay max usdc                       # Repay full outstanding debt

sol lend positions                            # All deposits and borrows across protocols
```

Positions include real-time APY, USD values, and health factor monitoring. The CLI warns when health factor drops below 1.1. Without `--protocol`, deposits auto-select the highest-yielding protocol, and withdrawals/repays auto-detect which protocol holds the position.

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

The portfolio aggregates tokens, staked SOL, lending positions, open orders, and prediction market positions across all wallets. Snapshots enable tracking changes over time — useful for agents that need to measure the impact of their actions.

### predict — Prediction markets via Jupiter

```bash
sol predict list                             # Browse all events by volume
sol predict list crypto                      # Filter by category
sol predict list sports --filter trending    # Trending sports events
sol predict search "solana"                  # Search by keyword

sol predict event POLY-89525                 # Event detail with all markets
sol predict market POLY-701571               # Market prices + orderbook

sol predict buy 5 yes POLY-701571            # Buy YES contracts with $5 USDC
sol predict buy 10 no POLY-559652 --max-price 0.40  # Buy NO with price limit
sol predict positions                        # All open positions with P&L
sol predict sell <positionPubkey>             # Sell/close a position
sol predict claim <positionPubkey>           # Claim winnings on resolved market
sol predict history                          # Transaction history
```

Markets are sourced from Polymarket and Kalshi via Jupiter's prediction market API. Categories include crypto, sports, politics, culture, economics, tech, finance, and more. Positions appear in `sol portfolio` with unrealized P&L, and claimable winnings are highlighted.

### fetch — Pay-per-request APIs with x402

```bash
sol fetch https://api.example.com/data          # Auto-pays if server returns 402
sol fetch https://api.example.com/data --dry-run # Show price without paying
sol fetch https://api.example.com/data --max 0.05  # Spending cap in USDC

sol fetch https://api.example.com/rpc \
  -X POST -d '{"query":"..."}' \
  -H "Accept: application/json"                 # POST with headers, like curl
```

Works like `curl` but handles [x402](https://x402.org) payment flows automatically. If the server returns `402 Payment Required`, the CLI signs a USDC transfer, attaches it to the retry, and prints the response body to stdout. Payment info goes to stderr so piped output stays clean.

Supports both x402 v1 (`X-PAYMENT`) and v2 (`PAYMENT-SIGNATURE`) protocols. The server provides the fee payer and submits the transaction — your wallet only partially signs.

### config — Persistent settings and security

```bash
sol config set rpc.url https://my-rpc.com     # Set RPC endpoint
sol config set api.jupiterApiKey YOUR_KEY     # Optional Jupiter API key
sol config get rpc.url                         # Read a value
sol config list                                # Show all settings
sol config path                                # Config file location
sol config status                              # Security posture overview
sol config lock                                # Lock security settings
```

By default, Sol uses Jupiter's lite API for zero-config operation. In the future it may be necessary to request a free API key from [portal.jup.ag](https://portal.jup.ag).

### Other commands

```bash
sol network                                   # Epoch, TPS, inflation, staking APY
sol tx 4xK9...abc                             # Look up a transaction by signature
```

---

## Structured Output

Every command supports `--json` for structured output. For most use cases — including LLM agents — the default human-readable output is easier to work with. Use `--json` when you need to chain commands in automation pipelines or parse results programmatically.

```json
{
  "ok": true,
  "data": { ... },
  "meta": { "elapsed_ms": 450 }
}
```

In JSON mode, confirmations are skipped automatically. Error codes are predictable `UPPER_SNAKE_CASE` identifiers (`SWAP_FAILED`, `LEND_DEPOSIT_FAILED`, etc.).

---

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output |
| `--rpc <url>` | Override RPC endpoint |
| `--verbose` | Show debug logging |

Most commands also accept `--wallet <name-or-address>` to override the default wallet.

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

- **Runtime**: Node.js (compiled from TypeScript)
- **CLI framework**: commander.js
- **Solana SDK**: `@solana/kit` v2
- **Swaps**: Jupiter REST API (no SDK, no API key)
- **Lending**: Kamino (`@kamino-finance/klend-sdk`), MarginFi (`@mrgnlabs/marginfi-client-v2`), Drift (`@drift-labs/sdk`), Jupiter Lend (REST), Loopscale (REST)
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
- Swap commands show quote details before executing

The CLI provides three layers of protection for agent-driven workflows:

1. **Permissions** — control which operations are allowed (swap, transfer, stake, etc.)
2. **Transaction limits** — cap per-transaction and daily USD spend
3. **Allowlists** — restrict which addresses and tokens can be used

### Quick setup for agents

```bash
# Set permissions, limits, and allowlists
sol config set permissions.canSwap true
sol config set permissions.canTransfer false
sol config set limits.maxTransactionUsd 500
sol config set limits.maxDailyUsd 2000
sol config set allowlist.tokens SOL,USDC,BONK

# Review the full security posture
sol config status

# Lock — prevents agents from changing settings via CLI
sol config lock
```

After locking, security settings can only be changed by a human editing `~/.sol/config.toml` directly. Use `sol config status` at any time to see permissions, limits, daily usage, allowlists, and warnings.

### Transaction limits

| Setting | Description |
|---|---|
| `limits.maxTransactionUsd` | Maximum USD value per transaction |
| `limits.maxDailyUsd` | Maximum total USD in a rolling 24h window |

Limits apply to swaps, sends, staking, deposits, borrows, DCA, and limit orders. They do not apply to withdrawals, MEV claims, or reads. Missing = no limit (backwards compatible).

### Allowlists

- **`allowlist.addresses`** — When set, `token send` is restricted to listed addresses plus your own wallets.
- **`allowlist.tokens`** — When set, both input and output tokens must be in the list for swaps, DCA, and limit orders. Accepts symbols (`SOL`) or mint addresses.

### Permissions

Restrict which operations are available — useful for giving agents limited access (e.g. monitor-only, swap-but-no-transfer). Disabled commands are not registered at all, so they won't appear in `--help`.

All permissions default to `true` (omitted = permitted):

| Permission | Gated subcommands |
|---|---|
| `canTransfer` | `token send` |
| `canSwap` | `token swap`, `token close --all`, `token dca new/cancel`, `token limit new/cancel` |
| `canStake` | `stake new` |
| `canWithdrawStake` | `stake withdraw`, `stake claim-mev` |
| `canLend` | `lend deposit` |
| `canWithdrawLend` | `lend withdraw` |
| `canBorrow` | `lend borrow`, `lend repay` |
| `canPredict` | `predict buy`, `predict sell`, `predict claim` |
| `canFetch` | `fetch` (x402 payments) |
| `canBurn` | `token burn`, `token close --burn` |
| `canCreateWallet` | `wallet create`, `wallet import` |
| `canRemoveWallet` | `wallet remove` |
| `canExportWallet` | `wallet export` |

### Threat model

An LLM agent using this tool cannot read the raw key material without explicitly opening the wallet files, which requires user approval in standard permission modes. Permissions, limits, and allowlists must all pass before the CLI will execute a transaction.

**What this does not protect against:** These controls operate at the CLI and agent-permission level. They do not prevent other software on the same machine from reading the key files. Any tool, MCP server, plugin, or script running under the same OS user account can read `~/.sol/wallets/` directly. Do not grant agents read or write access to `~/.sol/`.

Keep wallet balances appropriate to the risk: use dedicated wallets with limited funds for agent-driven workflows, and do not store large holdings in key files accessible to automated tooling.

## Disclaimer

This software interacts with the Solana blockchain and can execute irreversible transactions involving real funds. You are solely responsible for your own transactions, wallet security, and any financial outcomes. The authors are not liable for any losses. Use at your own risk.

## Tips

Token swaps include a small tip (2–100 bps, typically under 10 bps) paid to the compassSOL reserve, which boosts staking yield for Solana Compass delegators. The rate scales with swap cost — liquid pairs like SOL/USDC pay the minimum.

## License

MIT
