# sol — Solana CLI for Humans and LLM Agents

A Solana CLI with an expressive, scriptable API and structured JSON output. Built for LLM agents and humans alike.

```bash
sol token swap 1.5 SOL USDC
sol wallet balance --json
sol token price SOL USDC JUP
```

Every command supports `--json` for machine-readable output:

```json
{ "ok": true, "data": { ... }, "meta": { "elapsed_ms": 142 } }
```

## Install

```bash
# One-liner (requires Node.js >= 20)
npx @solana-compass/cli wallet list

# Or clone and run directly
git clone <repo> && cd sol
npm install
npx tsx src/index.ts --help
```

## Commands

### Wallet

```bash
sol wallet create                          # New wallet, auto-named
sol wallet create --name treasury          # Named wallet
sol wallet create --name bot --count 100   # Batch create bot-001..bot-100
sol wallet list                            # Name, address, labels
sol wallet list --label trading            # Filter by label
sol wallet balance                         # Default wallet, all tokens + USD
sol wallet balance treasury                # Specific wallet
sol wallet import ./key.json --name mykey  # Import from keypair file
sol wallet export treasury                 # Print path to key file
sol wallet remove old --delete             # Remove + delete key file
sol wallet label treasury --add trading    # Tag wallets
sol wallet fund                            # Fiat onramp URL (Transak)
sol wallet fund treasury --amount 100      # With prefilled amount
sol wallet history                         # Recent transaction log
sol wallet history --type swap --limit 5   # Filtered
```

### Token

```bash
sol token price SOL                        # Current USD price
sol token price SOL USDC JUP              # Multiple at once
sol token info USDC                        # Metadata (mint, decimals)
sol token list                             # All tokens in default wallet
sol token sync                             # Refresh token metadata cache
sol token swap 1.5 SOL USDC               # Swap via Jupiter
sol token swap 15000 USDC SOL --quote-only # Quote only
sol token swap 1.5 SOL USDC --slippage 100 # 1% slippage
sol token send 2.5 SOL <address>           # Send SOL
```

### Staking

```bash
sol stake list                             # All stake accounts
sol stake create 10                        # Create + fund stake account
sol stake delegate <stake> <validator>     # Delegate
sol stake deactivate <stake>
sol stake withdraw <stake>
```

### Lending (coming soon)

```bash
sol lend deposit 1000 USDC
sol lend withdraw 500 USDC
sol lend borrow 500 USDC --collateral SOL
sol lend repay 500 USDC
sol lend positions
sol lend rates USDC
```

### Liquidity Pools (coming soon)

```bash
sol lp pools USDC SOL
sol lp deposit <pool-id> 100 USDC 0.5 SOL
sol lp withdraw <pool-id>
sol lp positions
sol lp fees <pool-id>
sol lp claim <pool-id>
```

### Snapshots

```bash
sol snapshot take                          # Snapshot all wallets
sol snapshot take --label "before rebalance"
sol snapshot list
sol snapshot compare 1 2                   # P&L diff between snapshots
sol snapshot delete 1
```

### Config

```bash
sol config set rpc.url https://my-rpc.com
sol config get rpc.url
sol config list
sol config path
```

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output (for LLM agents) |
| `--rpc <url>` | Override RPC endpoint |
| `--wallet <name>` | Override default wallet |
| `--verbose` | Verbose logging to stderr |

## RPC Auto-Detection

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
| `data.db` | SQLite — wallets, token cache, price history, transaction log, snapshots |
| `wallets/*.json` | Keypair files (Solana CLI format, chmod 600) |

## Architecture

- **Runtime**: Node.js (via `tsx`) — no build step
- **CLI framework**: commander.js
- **Database**: SQLite via `better-sqlite3`
- **Solana SDK**: `@solana/kit` v2 (tree-shakeable)
- **Swaps**: Jupiter REST API (no SDK, no API key)
- **Prices**: Jupiter Price API + CoinGecko fallback
- **Token metadata**: Pluggable provider system, currently Jupiter Token API v2
- **Config**: TOML via `smol-toml`

## Security

- Key files are plain JSON (Solana CLI compatible), stored with `chmod 600`
- Private keys are never logged or printed to stdout
- `wallet export` returns the file path, not the key
- All transactions are logged to SQLite for audit
- Swap/send commands show details before executing (unless `--yes`)

## License

MIT
