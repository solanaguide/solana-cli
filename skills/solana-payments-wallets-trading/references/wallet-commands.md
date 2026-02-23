# Wallet Commands Reference

## Create a Wallet

```bash
sol wallet create                         # auto-named (wallet-1, wallet-2, ...)
sol wallet create --name trading          # pick a name
sol wallet create --name bot --count 5    # batch-create 5 wallets
```

Creates a new Ed25519 keypair and stores it as a JSON key file in
`~/.sol/wallets/<name>.json` (Solana CLI compatible format, chmod 600).

The first wallet created becomes the default for all commands.

## List Wallets

```bash
sol wallet list                           # all wallets with SOL balances
sol wallet list --label trading           # filter by label
```

Shows wallet name, address, SOL balance, and whether it's the default.
Hints at `sol wallet balance <name>` for full token breakdown.

## Check Balances

```bash
sol wallet balance                        # default wallet, all tokens + USD
sol wallet balance trading                # specific wallet
```

Displays every token held with current USD values. Tokens below the
dust threshold ($0.0001) are grouped as dust.

## Import an Existing Wallet

```bash
sol wallet import --solana-cli            # from ~/.config/solana/id.json
sol wallet import ./keypair.json --name cold
sol wallet import /path/to/key.json
```

Copies the key file into `~/.sol/wallets/`. The `--solana-cli` flag
imports from the default Solana CLI keypair location.

## Export / Show Key File Path

```bash
sol wallet export main
```

Prints the file system path to the key file. Does NOT print the
private key itself.

## Remove a Wallet

```bash
sol wallet remove old-wallet
```

Removes the wallet from the registry. The key file is renamed with a
`.deleted` suffix (not permanently deleted) so it can be recovered.

## Set Default Wallet

```bash
sol wallet set-default trading
```

Changes which wallet is used when `--wallet` is not specified.

## Labels

```bash
sol wallet label main --add trading       # add a label
sol wallet label main --add defi --add bot  # multiple labels
sol wallet label main --remove trading    # remove a label
```

Labels are freeform tags for organizing wallets. Use them with
`sol wallet list --label <label>` to filter.

## Transaction History

```bash
sol wallet history                        # recent transactions
sol wallet history --limit 20            # more results
sol wallet history --type swap           # filter by type (swap, send, stake, lend)
sol wallet history trading               # specific wallet
```

Shows transactions from the local log — type, tokens, amounts, USD
values at execution time, and timestamps.

## Fund via Fiat Onramp

```bash
sol wallet fund                          # default wallet, default amount
sol wallet fund --amount 50              # specify USD amount
sol wallet fund trading --provider moonpay
```

Generates a URL to purchase SOL via a fiat onramp provider. Opens
in your browser.

## Global Wallet Flag

Any command that operates on a wallet accepts `--wallet <name-or-address>`:

```bash
sol token swap 50 usdc bonk --wallet trading
sol stake new 10 --wallet cold
sol lend deposit 100 usdc --wallet defi
```

## JSON Output

All wallet commands support `--json`:

```bash
sol wallet list --json
sol wallet balance --json
```

### Example: `sol wallet list --json`

```json
{
  "ok": true,
  "data": {
    "wallets": [
      {
        "name": "main",
        "address": "7nY...xyz",
        "sol_balance": 12.5,
        "is_default": true,
        "labels": ["trading"]
      }
    ]
  },
  "meta": { "elapsed_ms": 320 }
}
```

## Data Storage

- Key files: `~/.sol/wallets/<name>.json`
- Wallet registry: `~/.sol/data.db` (SQLite)
- Config: `~/.sol/config.toml`
