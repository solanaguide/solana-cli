---
name: solana-payments-wallets-trading
description: >-
  Pay people in SOL or USDC, buy and sell tokens, check prices, manage Solana
  wallets, stake SOL, earn yield through lending, provide liquidity across
  multiple DEXes, trade prediction markets, pay for APIs via x402, and track
  portfolio performance — all from the command line. No API keys, no private
  key env vars. Use when the user wants to send crypto, trade, check balances,
  earn yield, provide liquidity, bet on predictions, pay for web resources,
  or see how their holdings are doing.
license: MIT
metadata:
  author: solanaguide
  version: 0.3.1
  openclaw:
    requires:
      bins:
        - node
        - npx
---

# Payments, Wallets and Trading on Solana

Sol is a command-line tool that lets you work with Solana the way you'd
describe it out loud. Instead of constructing transactions and managing
program instructions, you say what you want: pay someone, buy a token,
stake your SOL.

Keys live locally on disk — no private keys in environment variables,
no API keys to configure.

## Get Set Up

Prefer `npx` with `@latest` — it always runs the latest version with no
global install to manage:

```bash
npx @solana-compass/cli@latest config set rpc.url https://your-rpc-endpoint.com
npx @solana-compass/cli@latest wallet create --name my-wallet
```

If the user has installed globally (`npm install -g @solana-compass/cli`),
you can use the shorter `sol` command instead:

```bash
sol config set rpc.url https://your-rpc-endpoint.com
sol wallet create --name my-wallet
```

The public RPC endpoint rate-limits aggressively. Use a dedicated RPC
for anything beyond testing — Helius, Triton, and QuickNode all offer
free tiers.

Requires Node.js >= 20.

## Pay Someone

Send SOL, USDC, or any Solana token to a wallet address.

```bash
sol token send 50 usdc GkX...abc
sol token send 2 sol 7nY...xyz
sol token send 1000 bonk AgE...def --yes
```

Use `--yes` to skip the confirmation prompt — useful for automated
payments between agents or apps. Confirmations are also skipped
automatically in `--json` mode.

See references/trading-commands.md for the full send reference.

## Discover Tokens

Browse the Solana token ecosystem — trending, most traded, recently
launched, and more.

```bash
sol token browse trending                    # what's hot right now
sol token browse top-traded --interval 24h   # highest volume over 24h
sol token browse recent --limit 10           # just launched
sol token browse lst                         # liquid staking tokens
```

Results populate the local token cache, so subsequent `token info` and
`token price` calls resolve instantly.

See references/trading-commands.md for all categories and flags.

## Buy and Sell Tokens

Swap any token for any other token. Queries Jupiter and DFlow in
parallel and picks the best price automatically.

```bash
sol token swap 50 usdc bonk               # buy BONK — best price wins
sol token swap 1.5 sol usdc               # sell SOL for USDC
sol token swap 50 usdc bonk --quote-only  # preview without executing
sol token swap 50 usdc bonk --router jupiter  # force a specific router
```

Every swap records the price at execution time, so you can track
cost basis and P&L later.

See references/trading-commands.md for slippage, wallet selection, etc.

## DCA (Dollar-Cost Averaging)

Set up recurring buys that execute automatically over time.

```bash
sol token dca new 500 usdc sol --every day --count 10   # buy SOL daily
sol token dca new 1000 usdc bonk --every hour --count 20
sol token dca list                           # see active DCA orders
sol token dca cancel <orderKey>              # stop a DCA
```

Constraints: $100 total minimum, at least 2 orders, $50/order minimum.
Intervals: minute, hour, day, week, month.

## Limit Orders

Place orders that execute when a token hits your target price.

```bash
sol token limit new 50 usdc bonk --at 0.000003   # buy BONK at $0.000003
sol token limit new 0.5 sol usdc --at 0.90        # buy USDC at $0.90
sol token limit list                              # see active orders
sol token limit cancel <orderKey>                 # cancel an order
```

Use `--quote-only` to preview the order plan without placing it.

## Check Prices

```bash
sol token price sol
sol token price sol usdc bonk eth       # multiple at once
```

## See What You Have

```bash
sol wallet balance                      # all tokens with USD values
sol wallet balance trading              # specific wallet by name
sol token list                          # just token balances
sol wallet list                         # all your wallets
```

## Create and Manage Wallets

Wallets are local key files in `~/.sol/wallets/` — no seed phrases
in environment variables.

```bash
sol wallet create                       # new wallet, auto-named
sol wallet create --name trading        # pick a name
sol wallet import --solana-cli          # import from Solana CLI
sol wallet set-default trading          # switch active wallet
```

Any command can target a specific wallet with `--wallet <name>`.

See references/wallet-commands.md for import, export, labels, history.

## Stake SOL

Delegate SOL to a validator and earn staking rewards. One command
handles the entire process — creating the stake account, funding it,
and delegating.

```bash
sol stake new 10                        # stake 10 SOL
sol stake list                          # your stake accounts + claimable tips
sol stake claim-mev                     # compound MEV rewards
sol stake withdraw 7gK...abc            # unstake
```

See references/staking-commands.md for validator selection, partial
withdrawals, and force unstake.

## Earn Yield by Lending

Compare rates and lend across five protocols — Kamino, MarginFi,
Drift, Jupiter Lend, and Loopscale. The CLI auto-picks the best
rate, or you can target a specific protocol with `--protocol`.

```bash
sol lend rates usdc                     # compare APY across all protocols
sol lend deposit 100 usdc               # auto-picks best deposit rate
sol lend deposit 5 sol --protocol kamino
sol lend borrow 500 usdc --collateral sol
sol lend positions                      # everything across all protocols
```

See references/lending-commands.md for full details.

## Provide Liquidity

Add liquidity to pools across Orca, Raydium, Meteora, and Kamino.
Browse pools by TVL/APY/volume, deposit with flexible price ranges,
track positions with P&L and impermanent loss, and farm for extra
rewards.

```bash
sol lp pools sol usdc                          # browse SOL/USDC pools
sol lp pools --sort apy --type clmm            # highest APY concentrated pools
sol lp deposit HJPj...abc 100 usdc --range 10  # deposit with +/-10% price range
sol lp positions                               # all positions with P&L
sol lp claim 9xK...abc                         # claim unclaimed fees
sol lp withdraw 9xK...abc                      # remove liquidity
```

See references/lp-commands.md for full details including farming,
pool creation, and protocol-specific flags.

## Trade Prediction Markets

Browse and trade prediction markets from Polymarket and Kalshi via
Jupiter. Categories include crypto, sports, politics, culture, and more.

```bash
sol predict list crypto                     # browse crypto events
sol predict search "solana"                 # search by keyword
sol predict event POLY-89525                # event detail with markets
sol predict market POLY-701571              # prices + orderbook

sol predict buy 5 yes POLY-701571           # buy YES contracts
sol predict positions                       # open positions with P&L
sol predict sell <positionPubkey>            # close a position
sol predict claim <positionPubkey>           # claim resolved winnings
sol predict history                         # transaction history
```

Positions appear in `sol portfolio` with unrealized P&L.

See references/prediction-commands.md for the full reference.

## Pay for APIs with x402

Fetch URLs that require payment via the x402 protocol. Works like
`curl` — stdout is the response body, payment info goes to stderr.

```bash
sol fetch https://api.example.com/data             # auto-pays 402 responses
sol fetch https://api.example.com/data --dry-run   # show price without paying
sol fetch https://api.example.com/data --max 0.05  # spending cap in USDC

sol fetch https://api.example.com/rpc \
  -X POST -d '{"query":"..."}' \
  -H "Accept: application/json"                    # POST with headers
```

If the server returns 402 Payment Required, the CLI signs a USDC
transfer and retries with the payment attached. The server submits
the transaction — your wallet only partially signs.

Use `--dry-run` to inspect the cost before paying. Use `--max` to
set a spending cap. Output is pipe-friendly by default; use `--json`
for the structured envelope.

See references/fetch-commands.md for the full reference including
curl flag mapping and JSON output format.

## Track How Your Portfolio Is Doing

See everything in one place — tokens, staked SOL, lending positions,
and open orders.

```bash
sol portfolio                           # the full picture
sol portfolio compare                   # what changed since last snapshot
sol portfolio pnl                       # profit and loss over time
```

The portfolio view includes active DCA and limit orders with fill
progress, so locked capital is always visible. A snapshot is taken
automatically on each view (rate-limited to every 5 minutes), so
`sol portfolio compare` always has recent data.

See references/portfolio-commands.md for snapshot management.

## Structured Output

Every command supports `--json` for structured output. For most use
cases the default human-readable output is easier to work with — use
`--json` when chaining commands in automation pipelines or parsing
results programmatically.

In JSON mode, confirmations are skipped automatically.

```json
{ "ok": true, "data": { ... }, "meta": { "elapsed_ms": 450 } }
```

Error codes are `UPPER_SNAKE_CASE` (e.g. `SWAP_FAILED`). Check the
`ok` field before reading `data`.

See references/json-output-format.md for the full schema.

## Other Useful Commands

```bash
sol network                             # epoch, TPS, staking APY
sol tx 4xK9...abc                       # look up any transaction
sol config set rpc.url <url>            # change RPC endpoint
```

## Tips

- **Keep SOL for gas.** Every Solana transaction costs ~0.000005 SOL,
  but token account creation costs ~0.002 SOL. Unless the user
  specifically asks to drain or close a wallet, keep at least 0.05 SOL
  as a reserve so future transactions don't fail.
- **Use full numbers, not shorthand.** The CLI expects literal
  amounts: `1000000` not `1m`, `50000` not `50k`. Always expand
  shorthand before passing to a command.
- **Addresses are raw public keys only.** The CLI does not resolve
  .sol domains, SNS names, or contact labels — pass the full base58
  public key for recipients.
- **Ambiguous symbols pick the highest-liquidity match.** If a symbol
  maps to multiple tokens, the CLI picks the one with the most
  trading volume on Jupiter. It does not prompt. Use `sol token info
  <symbol>` to verify what it resolves to, or pass a mint address
  to be explicit.
- Use `--quote-only` on swaps to preview before committing
- Use `--wallet <name>` to target a specific wallet
- The transaction log tracks all operations with USD prices at
  execution time — useful for cost basis and P&L

## Permissions

The CLI supports fine-grained permissions via `~/.sol/config.toml`. When a permission is set to `false`, the gated commands are not registered — they won't appear in `--help` or `sol <group> --help`, and invoking them returns "unknown command".

All permissions default to `true` (omitted = permitted). Example read-only config:

```toml
[permissions]
canTransfer = false
canSwap = false
canStake = false
canWithdrawStake = false
canLend = false
canWithdrawLend = false
canBorrow = false
canBurn = false
canCreateWallet = false
canRemoveWallet = false
canExportWallet = false
canFetch = false
```

| Permission | Gated subcommands |
|---|---|
| `canTransfer` | `token send` |
| `canSwap` | `token swap`, `token close --all`, `token dca new/cancel`, `token limit new/cancel` |
| `canStake` | `stake new` |
| `canWithdrawStake` | `stake withdraw`, `stake claim-mev` |
| `canLend` | `lend deposit`, `lp deposit`, `lp farm stake`, `lp create` |
| `canWithdrawLend` | `lend withdraw`, `lp withdraw`, `lp claim`, `lp farm unstake/harvest` |
| `canBorrow` | `lend borrow`, `lend repay` |
| `canBurn` | `token burn`, `token close --burn` |
| `canCreateWallet` | `wallet create`, `wallet import` |
| `canRemoveWallet` | `wallet remove` |
| `canExportWallet` | `wallet export` |
| `canFetch` | `fetch` (x402 payments) |

Read-only commands (`token browse/price/info/list`, `wallet list/balance`, `stake list`, `lend rates/positions`, `lp pools/info/positions/farm list`, `portfolio`, `network`, `tx`) are always available regardless of permissions.

## Security Controls

The CLI provides three layers of protection for agent-driven workflows: **permissions** (what operations are allowed), **transaction limits** (how much can be spent), and **allowlists** (which addresses and tokens are permitted).

### Setting Up Security

Agents can help configure security settings, then the user reviews and locks:

```bash
# 1. Set permissions
sol config set permissions.canSwap true
sol config set permissions.canTransfer false

# 2. Set transaction limits
sol config set limits.maxTransactionUsd 500
sol config set limits.maxDailyUsd 2000

# 3. Set allowlists
sol config set allowlist.tokens So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
sol config set allowlist.addresses DRtXHDgC312wpNdNCSb8vCoXDcofCJcPHdAynKGz7Vr,7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

# 4. Review — confirm everything looks right before locking
sol config status

# 5. Lock — prevents all further changes via CLI
sol config lock
```

After locking, security settings can only be changed by a human editing `~/.sol/config.toml` directly.

### Transaction Limits

| Setting | Description |
|---|---|
| `limits.maxTransactionUsd` | Maximum USD value per transaction. Missing = no limit. |
| `limits.maxDailyUsd` | Maximum total USD spent in a rolling 24h window. Missing = no limit. |

Limits apply to: `token swap`, `token send`, `stake new`, `lend deposit`, `lend borrow`, DCA creation, and limit order creation. They do not apply to withdrawals to own wallet, MEV claims, or read operations.

### Address Allowlist

`allowlist.addresses` — comma-separated list of wallet addresses. When set, outbound transfers (`token send`) are restricted to listed addresses plus all wallets in the local wallet database (own wallets are always allowed). Empty or missing = no restriction.

### Token Allowlist

`allowlist.tokens` — comma-separated list of token symbols or mint addresses. When set, both input and output tokens must be in the list for swaps, DCA creation, and limit orders. Empty or missing = all tokens allowed.

### Checking Security Status

```bash
sol config status              # human-readable security overview
sol config status --json       # structured output for agents
```

Shows the full security posture: all permissions and whether they're enabled, transaction limits with current 24h usage, address and token allowlists, whether settings are locked, and warnings about potential risks (e.g. no limits configured, public RPC in use). Agents should use `sol config status --json` to understand what they're allowed to do — not by reading `config.toml` directly.

### Important: Filesystem Access

**Do not grant agents read or write access to `~/.sol/`.** This directory contains your private keys and security configuration. Agents should only interact with Solana through the `sol` CLI commands, never by reading config or key files directly. After helping set up security, recommend the user lock settings with `sol config lock` and restrict filesystem access to `~/.sol/`.

## Security Model

Private keys are stored as files in `~/.sol/wallets/`. The CLI reads them at transaction-signing time — they are never exposed as environment variables or printed to stdout. An LLM agent using this tool cannot read the raw key material without explicitly opening those files, which requires user approval in standard permission modes.

Permissions, limits, and allowlists work together to control what the CLI can do. The agent must have the permission enabled, pass limit and allowlist checks, *and* get user approval for each CLI invocation.

**What this does not protect against:** These controls operate at the CLI and agent-permission level. They do not prevent other software on the same machine from reading the key files. Any tool, MCP server, plugin, or script running under the same OS user account can read `~/.sol/wallets/` directly. If you grant an agent access to additional tools — especially ones that can read arbitrary files or execute shell commands — those tools can extract your private keys regardless of Sol CLI permissions.

Keep wallet balances appropriate to the risk: use dedicated wallets with limited funds for agent-driven workflows, and do not store large holdings in key files accessible to automated tooling.

## Troubleshooting

See references/troubleshooting.md for common issues (RPC rate limits,
token resolution, transaction timeouts).
