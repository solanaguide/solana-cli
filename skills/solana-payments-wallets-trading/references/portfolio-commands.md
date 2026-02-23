# Portfolio Commands Reference

## View Portfolio

```bash
sol portfolio
sol portfolio --wallet trading
```

Unified view of everything you hold — tokens, staked SOL, and lending
positions — with USD values.

### JSON Output

```json
{
  "ok": true,
  "data": {
    "positions": [
      {
        "type": "token",
        "symbol": "SOL",
        "amount": 12.5,
        "value_usd": 1878.13
      },
      {
        "type": "stake",
        "symbol": "SOL",
        "amount": 10,
        "value_usd": 1502.50,
        "validator": "Comp...ass",
        "status": "active"
      },
      {
        "type": "lend",
        "symbol": "USDC",
        "amount": 100,
        "value_usd": 100,
        "protocol": "kamino",
        "apy": "8.5%"
      }
    ],
    "total_value_usd": 3480.63
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

Snapshots include ALL position types — tokens, stakes, and lending.

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
