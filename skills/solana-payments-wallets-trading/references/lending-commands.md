# Lending Commands Reference

Lending and borrowing on Kamino Finance.

## Check Rates

```bash
sol lend rates <token>
```

Shows current deposit APY and borrow APY for a token on Kamino.

### Examples

```bash
sol lend rates usdc
sol lend rates sol
```

### JSON Output

```json
{
  "ok": true,
  "data": {
    "token": "USDC",
    "deposit_apy": "8.5%",
    "borrow_apy": "12.3%",
    "total_deposits": 150000000,
    "total_borrows": 95000000,
    "utilization": "63.3%"
  },
  "meta": { "elapsed_ms": 800 }
}
```

## Deposit

```bash
sol lend deposit <amount> <token>
```

Deposits tokens into a Kamino vault to earn yield.

### Examples

```bash
sol lend deposit 100 usdc
sol lend deposit 5 sol
sol lend deposit 100 usdc --wallet trading
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <name>` | default | Wallet to deposit from |

## Withdraw

```bash
sol lend withdraw <amount|max> <token>
```

Withdraws tokens from Kamino.

### Examples

```bash
sol lend withdraw 50 usdc                 # partial withdrawal
sol lend withdraw max sol                 # withdraw everything
sol lend withdraw max usdc --wallet defi
```

Use `max` to withdraw the entire deposited amount.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet <name>` | default | Wallet that owns the deposit |

## Borrow

```bash
sol lend borrow <amount> <token> --collateral <token>
```

Borrows tokens against deposited collateral.

### Examples

```bash
sol lend borrow 500 usdc --collateral sol
sol lend borrow 1 sol --collateral usdc
```

You must have sufficient collateral deposited first. The CLI will
warn if the resulting health factor would be dangerously low.

### Flags

| Flag | Description |
|------|-------------|
| `--collateral <token>` | Required. Token to use as collateral |
| `--wallet <name>` | Wallet that owns the collateral |

## Repay

```bash
sol lend repay <amount|max> <token>
```

Repays borrowed tokens.

### Examples

```bash
sol lend repay 250 usdc                   # partial repay
sol lend repay max usdc                   # repay full outstanding debt
```

Use `max` to repay the entire borrowed amount.

## View Positions

```bash
sol lend positions
sol lend positions --wallet trading
```

Lists all deposits and borrows — token, amount, APY, USD value,
and health factor.

The CLI warns when health factor drops below 1.1.

### JSON Output

```json
{
  "ok": true,
  "data": {
    "deposits": [
      {
        "token": "USDC",
        "amount": 100,
        "value_usd": 100,
        "apy": "8.5%"
      }
    ],
    "borrows": [
      {
        "token": "USDC",
        "amount": 50,
        "value_usd": 50,
        "apy": "12.3%"
      }
    ],
    "health_factor": 2.1,
    "net_value_usd": 50
  },
  "meta": { "elapsed_ms": 1000 }
}
```

## Health Factor

Health factor = total collateral value / total borrow value (weighted
by liquidation thresholds). Below 1.0 means liquidation risk.

- **> 2.0**: Safe
- **1.1 – 2.0**: Monitor closely
- **< 1.1**: CLI warns — consider repaying or adding collateral
- **< 1.0**: Liquidation possible
