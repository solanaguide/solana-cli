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

# Deposit USDC to earn yield on Kamino
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
npx @solana-compass/cli wallet list
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

## Structured Output

Every command supports `--json` for automation and scripting:

```json
{
  "ok": true,
  "data": { ... },
  "meta": { "elapsed_ms": 450 }
}
```

Error codes are predictable `UPPER_SNAKE_CASE` identifiers (`SWAP_FAILED`, `LEND_DEPOSIT_FAILED`, etc.).

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
- Swap commands show quote details before executing

## Disclaimer

This software interacts with the Solana blockchain and can execute irreversible transactions involving real funds. You are solely responsible for your own transactions, wallet security, and any financial outcomes. The authors are not liable for any losses. Use at your own risk.

## License

MIT
