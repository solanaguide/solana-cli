# Prediction Market Commands Reference

Browse, search, and trade prediction markets via Jupiter. Markets are
sourced from Polymarket and Kalshi. Settlements are in USDC.

## Browse Events

```bash
sol predict list [category]
```

Browse prediction events. Categories: `crypto`, `sports`, `politics`,
`esports`, `culture`, `economics`, `tech`, `finance`, `climate & science`.

### Examples

```bash
sol predict list                           # all events
sol predict list crypto                    # crypto events only
sol predict list sports --filter trending  # trending sports events
sol predict list --limit 10               # limit results
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--filter <type>` | none | Filter: `new`, `live`, `trending`, `upcoming` |
| `--limit <n>` | 20 | Number of results |

### JSON Output

```json
{
  "ok": true,
  "data": {
    "category": "crypto",
    "events": [
      {
        "id": "POLY-89525",
        "title": "What price will Solana hit in 2026?",
        "category": "crypto",
        "markets": [ ... ],
        "volume": 125000,
        "status": "live"
      }
    ]
  },
  "meta": { "elapsed_ms": 500 }
}
```

## Search Events

```bash
sol predict search <query>
```

Search events by keyword.

### Examples

```bash
sol predict search "solana"
sol predict search "super bowl" --limit 5
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--limit <n>` | 20 | Number of results |

## View Event Details

```bash
sol predict event <eventId>
```

Shows an event and all its markets with YES/NO prices.

### Examples

```bash
sol predict event POLY-89525
```

## View Market Details

```bash
sol predict market <marketId>
```

Shows detailed market info — YES/NO prices, volume, resolution status,
and orderbook depth (top 10 levels).

### Examples

```bash
sol predict market POLY-701571
```

### JSON Output

```json
{
  "ok": true,
  "data": {
    "market": {
      "id": "POLY-701571",
      "title": "↑ 200",
      "yesPrice": 0.35,
      "noPrice": 0.65,
      "volume": 50000,
      "status": "live",
      "resolution": null
    },
    "orderbook": {
      "yes": [{ "price": 0.35, "quantity": 150 }],
      "no": [{ "price": 0.65, "quantity": 200 }]
    }
  },
  "meta": { "elapsed_ms": 600 }
}
```

## Buy Contracts

```bash
sol predict buy <amount> <yes|no> <marketId>
```

Buy YES or NO contracts with USDC. The amount is in USD.

### Examples

```bash
sol predict buy 5 yes POLY-701571               # buy YES contracts with $5
sol predict buy 10 no POLY-559652                # buy NO contracts with $10
sol predict buy 5 yes POLY-701571 --max-price 0.40  # limit entry price
sol predict buy 5 yes POLY-701571 --wallet trading
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max-price <price>` | none | Maximum price per contract (0–1) |
| `--wallet <name>` | default | Wallet to use |

### Permission

Requires `canPredict = true` in `~/.sol/config.toml`.

### Notes

- Minimum deposit is approximately $2 USDC.
- Cost basis is recorded at buy time for P&L tracking.
- Positions appear in `sol predict positions` and `sol portfolio`.

## Sell a Position

```bash
sol predict sell <positionPubkey>
```

Close an open position by selling the contracts.

### Examples

```bash
sol predict sell 7gK...abc
sol predict sell 7gK...abc --wallet trading
sol predict sell 7gK...abc --min-price 0.50
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--min-price <price>` | none | Minimum sell price per contract (0–1) |
| `--wallet <name>` | default | Wallet that owns the position |

### Permission

Requires `canPredict = true`.

## Claim Winnings

```bash
sol predict claim <positionPubkey>
```

Claim winnings on a resolved market. Only works if the market has
settled and the position is on the winning side.

### Examples

```bash
sol predict claim 7gK...abc
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <name>` | default | Wallet that owns the position |

### Permission

Requires `canPredict = true`.

### Notes

Winning contracts pay out $1.00 each. The CLI calculates realized P&L
relative to your cost basis.

## View Positions

```bash
sol predict positions
```

Lists all open and claimable prediction positions with cost basis,
current value, and unrealized P&L.

### Examples

```bash
sol predict positions
sol predict positions --wallet trading
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <name>` | default | Wallet to check |

### JSON Output

```json
{
  "ok": true,
  "data": {
    "wallet": "main",
    "positions": [
      {
        "pubkey": "7gK...abc",
        "marketTitle": "↑ 200",
        "eventTitle": "What price will Solana hit in 2026?",
        "isYes": true,
        "contracts": 14.28,
        "costBasisUsd": 5.0,
        "currentValueUsd": 5.71,
        "unrealizedPnlUsd": 0.71,
        "claimable": false,
        "status": "open"
      }
    ]
  },
  "meta": { "elapsed_ms": 800 }
}
```

Claimable positions are highlighted — run `sol predict claim` to
collect winnings.

## Transaction History

```bash
sol predict history
```

Shows prediction market transaction history (buys, sells, claims).

### Examples

```bash
sol predict history
sol predict history --wallet trading
sol predict history --limit 10
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <name>` | default | Wallet to check |
| `--limit <n>` | 50 | Number of entries |

## Portfolio Integration

Prediction positions appear in `sol portfolio` alongside tokens,
staked SOL, and lending positions. Each position shows:

- Market name (event + market title)
- Side (YES / NO)
- Contracts held
- Cost basis and current value
- Unrealized P&L

Snapshots include prediction positions, so `sol portfolio compare`
tracks how positions change over time.

## Permissions

Write commands (`buy`, `sell`, `claim`) are gated by the `canPredict`
permission. Read commands (`list`, `search`, `event`, `market`,
`positions`, `history`) are always available.

```toml
[permissions]
canPredict = false   # disables buy/sell/claim
```

## Geo-Restrictions

Jupiter's prediction markets API is not available from US and South
Korea IP addresses. Commands will fail with a network error from these
locations.
