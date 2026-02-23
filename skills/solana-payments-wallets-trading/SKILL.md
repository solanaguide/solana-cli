---
name: solana-payments-wallets-trading
description: >-
  Pay people in SOL or USDC, buy and sell tokens, check prices, manage Solana
  wallets, stake SOL, earn yield through lending, and track portfolio
  performance — all from the command line. No API keys, no private key env
  vars. Use when the user wants to send crypto, trade, check balances, earn
  yield, or see how their holdings are doing.
license: MIT
metadata:
  author: solanaguide
  version: 0.2.1
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

```bash
npm install -g @solana-compass/cli
sol config set rpc.url https://your-rpc-endpoint.com
sol wallet create --name my-wallet
```

The public RPC endpoint rate-limits aggressively. Use a dedicated RPC
for anything beyond testing — Helius, Triton, and QuickNode all offer
free tiers.

Or run without installing:

```bash
npx @solana-compass/cli wallet list
```

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

## Buy and Sell Tokens

Swap any token for any other token. Prices come from Jupiter — best
rate across every Solana DEX, no API key needed.

```bash
sol token swap 50 usdc bonk             # buy BONK with USDC
sol token swap 1.5 sol usdc             # sell SOL for USDC
sol token swap 50 usdc bonk --quote-only  # preview without executing
```

Every swap records the price at execution time, so you can track
cost basis and P&L later.

See references/trading-commands.md for slippage, wallet selection, etc.

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

Deposit tokens into Kamino Finance to earn interest, or borrow
against your deposits.

```bash
sol lend rates usdc                     # current APY
sol lend deposit 100 usdc               # start earning
sol lend borrow 500 usdc --collateral sol
sol lend positions                      # everything you've got open
```

See references/lending-commands.md for full details.

## Track How Your Portfolio Is Doing

See everything in one place — tokens, staked SOL, lending positions.

```bash
sol portfolio                           # the full picture
sol portfolio snapshot --label "monday"
sol portfolio compare                   # what changed since last snapshot
sol portfolio pnl                       # profit and loss over time
```

See references/portfolio-commands.md for snapshot management.

## Structured Output

Every command supports `--json` for structured output. In JSON mode,
confirmations are skipped automatically.

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

- Use mint addresses instead of symbols when you know the exact token
  (avoids symbol ambiguity)
- Use `--quote-only` on swaps to preview before committing
- Use `--wallet <name>` to target a specific wallet
- The transaction log tracks all operations with USD prices at
  execution time — useful for cost basis and P&L

## Troubleshooting

See references/troubleshooting.md for common issues (RPC rate limits,
token resolution, transaction timeouts).
