# Trading Commands Reference

## Swap Tokens

```bash
sol token swap <amount> <from> <to>
```

Swaps tokens via Jupiter aggregator — best price across all Solana DEXes.

### Examples

```bash
sol token swap 50 usdc bonk               # buy BONK with USDC
sol token swap 1.5 sol usdc               # sell SOL for USDC
sol token swap 100 usdc sol --wallet bot   # from a specific wallet
sol token swap 50 usdc bonk --quote-only   # preview without executing
sol token swap 50 usdc bonk --slippage 100 # 1% slippage (100 bps)
sol token swap 50 usdc bonk --yes          # skip confirmation
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--slippage <bps>` | 50 | Slippage tolerance in basis points (50 = 0.5%) |
| `--quote-only` | false | Show quote without executing |
| `--wallet <name>` | default | Wallet to swap from |
| `--yes` | false | Skip confirmation prompt |

### Token Resolution

Tokens can be specified by symbol (`sol`, `usdc`, `bonk`) or mint
address. Resolution order:

1. Hardcoded well-known list (SOL, USDC, USDT, JUP, BONK, mSOL,
   jitoSOL, bSOL, ETH, wBTC, PYTH, JTO, WEN, RNDR, JLP)
2. Local SQLite cache (24-hour TTL)
3. Jupiter Token API (ranked by liquidity)

For safety with unfamiliar tokens, verify with `sol token info <symbol>`
first, or use the mint address directly.

### JSON Output

```json
{
  "ok": true,
  "data": {
    "signature": "4xK9...abc",
    "from_token": "USDC",
    "from_amount": 50,
    "to_token": "BONK",
    "to_amount": 2500000,
    "price_impact": "0.01%",
    "from_price_usd": 1.0,
    "to_price_usd": 0.00002
  },
  "meta": { "elapsed_ms": 2100 }
}
```

## Send Tokens

```bash
sol token send <amount> <token> <recipient>
```

Send SOL or any SPL token to a wallet address.

### Examples

```bash
sol token send 2 sol 7nY...xyz
sol token send 50 usdc GkX...abc
sol token send 1000 bonk AgE...def --yes
sol token send 0.5 sol 7nY...xyz --wallet trading
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <name>` | default | Wallet to send from |
| `--yes` | false | Skip confirmation prompt |

In `--json` mode, confirmations are always skipped.

### JSON Output

```json
{
  "ok": true,
  "data": {
    "signature": "5aB...xyz",
    "token": "USDC",
    "amount": 50,
    "recipient": "GkX...abc",
    "price_usd": 1.0
  },
  "meta": { "elapsed_ms": 1500 }
}
```

## Check Prices

```bash
sol token price <symbols...>
```

### Examples

```bash
sol token price sol                       # single token
sol token price sol usdc bonk eth         # multiple at once
```

Prices come from Jupiter Price API with CoinGecko fallback.

### JSON Output

```json
{
  "ok": true,
  "data": {
    "prices": [
      { "symbol": "SOL", "price_usd": 150.25, "mint": "So11...1112" }
    ]
  },
  "meta": { "elapsed_ms": 200 }
}
```

## Token Info

```bash
sol token info <symbol>
```

Shows token metadata — mint address, decimals, total supply. Useful
for verifying which token a symbol resolves to before transacting.

## List Tokens

```bash
sol token list                            # default wallet
sol token list --wallet trading           # specific wallet
```

Lists all tokens held in the wallet with balances and USD values.

## Burn Tokens

```bash
sol token burn <symbol> [amount]
```

### Examples

```bash
sol token burn bonk 1000                  # burn specific amount
sol token burn bonk --all                 # burn entire balance
sol token burn bonk --all --close         # burn and close the account
```

### Flags

| Flag | Description |
|------|-------------|
| `--all` | Burn entire balance |
| `--close` | Close the token account after burning (reclaims ~0.002 SOL rent) |
| `--wallet <name>` | Wallet to burn from |
| `--yes` | Skip confirmation |

## Close Token Accounts

```bash
sol token close [symbol]
```

Closes empty token accounts and reclaims rent (~0.002 SOL each).

### Examples

```bash
sol token close usdc                      # close specific account
sol token close --all --yes               # close all empty accounts
sol token close --all --burn --yes        # burn dust + close all
```

### Flags

| Flag | Description |
|------|-------------|
| `--all` | Close all eligible accounts |
| `--burn` | Burn remaining dust before closing |
| `--wallet <name>` | Wallet to close accounts in |
| `--yes` | Skip confirmation |

## Sync Token Cache

```bash
sol token sync
```

Refreshes the local token metadata cache from Jupiter's token list.
Normally not needed — tokens are cached on first use.
