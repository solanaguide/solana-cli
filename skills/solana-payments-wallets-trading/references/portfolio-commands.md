# Portfolio Commands Reference

## View Portfolio

```bash
sol portfolio
sol portfolio --wallet trading
```

Unified view of everything you hold — tokens, staked SOL, lending
positions, and open orders (DCA + limit) — with USD values and
allocation breakdown.

Active DCA and limit orders appear in the **Open Orders** section
with a fill percentage showing progress. Locked capital in orders
counts toward your total and allocation.

A snapshot is taken automatically on each portfolio view
(rate-limited to once every 5 minutes), so `sol portfolio compare`
always has recent data to work with.

### JSON Output

```json
{
  "ok": true,
  "data": {
    "wallets": [
      { "name": "main", "address": "C9dzXf...hVVH" }
    ],
    "positions": [
      {
        "type": "token",
        "symbol": "SOL",
        "amount": 12.5,
        "valueUsd": 1878.13
      },
      {
        "type": "stake",
        "symbol": "SOL",
        "amount": 10,
        "valueUsd": 1502.50,
        "extra": { "validator": "Comp...ass", "status": "active" }
      },
      {
        "type": "lend",
        "symbol": "USDC",
        "amount": 100,
        "valueUsd": 100,
        "extra": { "side": "deposit", "apy": 0.085 }
      },
      {
        "type": "order",
        "symbol": "USDC",
        "amount": 50.5,
        "valueUsd": 50.5,
        "extra": {
          "orderType": "dca",
          "outputSymbol": "SOL",
          "fillPct": 50,
          "status": "active"
        }
      }
    ],
    "totalValueUsd": 3480.63
  },
  "meta": { "elapsed_ms": 2500 }
}
```

## Take a Snapshot

```bash
sol portfolio snapshot
sol portfolio snapshot --label "pre-trade"
sol portfolio snapshot --wallet trading
```

Saves the current portfolio state to SQLite for later comparison.

### Flags

| Flag | Description |
|------|-------------|
| `--label <text>` | Human-readable label for the snapshot |
| `--wallet <name>` | Snapshot a specific wallet only |

Snapshots include ALL position types — tokens, stakes, lending, and
open orders. You usually don't need to run this manually since
`sol portfolio` auto-snapshots on every view.

## List Snapshot History

```bash
sol portfolio history
```

Lists all saved snapshots with ID, timestamp, label, and total value.

## Compare to a Snapshot

```bash
sol portfolio compare                     # vs latest snapshot
sol portfolio compare 3                   # vs snapshot #3
sol portfolio compare --wallet trading
```

Shows what changed since the snapshot — added/removed positions,
value changes, token price movements.

## Profit and Loss

```bash
sol portfolio pnl
sol portfolio pnl --since 5              # P&L since snapshot #5
sol portfolio pnl --wallet trading
```

Calculates profit and loss based on the transaction log and snapshots.
The transaction log records USD prices at execution time, so cost
basis is computed automatically.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--since <id>` | first snapshot | Calculate P&L from this snapshot |
| `--wallet <name>` | all wallets | Limit to a specific wallet |

## Delete a Snapshot

```bash
sol portfolio delete 3
```

Permanently removes a snapshot by ID.

## Automated Snapshots

```bash
sol portfolio cron
```

Prints a crontab entry you can install to take snapshots automatically
(e.g. daily at midnight). Useful for long-running portfolio tracking.

## Tips

- Take snapshots before and after significant trades to measure impact
- Use labels to mark meaningful points ("post-rebalance", "pre-airdrop")
- The transaction log is the source of truth for cost basis — snapshots
  are for point-in-time comparisons
