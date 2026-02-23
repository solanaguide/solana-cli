# JSON Output Format Reference

Every Sol CLI command supports `--json` for structured output.

## Response Envelope

All responses use the `CommandResult<T>` envelope:

```json
{
  "ok": true,
  "data": { ... },
  "meta": {
    "elapsed_ms": 450
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | `true` on success, `false` on failure |
| `data` | `T` | Command-specific response data (present on success) |
| `error` | `string` | Error code in `UPPER_SNAKE_CASE` (present on failure) |
| `message` | `string` | Human-readable error description (present on failure) |
| `meta` | `object` | Metadata — always includes `elapsed_ms` |

## Success Response

```json
{
  "ok": true,
  "data": {
    "signature": "4xK9...abc",
    "from_token": "USDC",
    "to_token": "BONK",
    "from_amount": 50,
    "to_amount": 2500000
  },
  "meta": { "elapsed_ms": 2100 }
}
```

Always check `ok === true` before reading `data`.

## Error Response

```json
{
  "ok": false,
  "error": "SWAP_FAILED",
  "message": "Insufficient balance: need 50 USDC, have 12.5 USDC",
  "meta": { "elapsed_ms": 150 }
}
```

## Error Code Convention

Error codes follow `NOUN_VERB_FAILED` format in `UPPER_SNAKE_CASE`:

| Code | When |
|------|------|
| `WALLET_CREATE_FAILED` | Wallet creation fails |
| `BALANCE_FAILED` | Balance lookup fails |
| `SWAP_FAILED` | Token swap fails |
| `SEND_FAILED` | Token send fails |
| `STAKE_NEW_FAILED` | Stake creation fails |
| `STAKE_WITHDRAW_FAILED` | Stake withdrawal fails |
| `LEND_DEPOSIT_FAILED` | Lending deposit fails |
| `LEND_WITHDRAW_FAILED` | Lending withdrawal fails |
| `LEND_BORROW_FAILED` | Borrowing fails |
| `LEND_REPAY_FAILED` | Loan repayment fails |
| `PORTFOLIO_FETCH_FAILED` | Portfolio fetch fails |
| `CONFIG_SET_FAILED` | Config update fails |
| `NETWORK_FAILED` | Network info fetch fails |
| `TOKEN_LIST_FAILED` | Token list fetch fails |

## Exit Codes

- `0` — Success
- `1` — Command failed (error details in JSON response)

## JSON Mode Behavior

When `--json` is active:

- Confirmation prompts are skipped automatically (equivalent to `--yes`)
- Human-readable output is suppressed
- Only the JSON envelope is printed to stdout
- Debug/verbose output goes to stderr (if `--verbose` is also set)

## Global Flags

These flags work with any command:

```bash
sol <command> --json                      # structured output
sol <command> --rpc https://my-rpc.com    # override RPC
sol <command> --verbose                   # debug logging
sol <command> --wallet trading            # override wallet
```

## Usage in Scripts

```bash
# Check if a swap succeeded
result=$(sol token swap 50 usdc bonk --json)
if echo "$result" | jq -e '.ok' > /dev/null; then
  sig=$(echo "$result" | jq -r '.data.signature')
  echo "Swap succeeded: $sig"
else
  error=$(echo "$result" | jq -r '.error')
  echo "Swap failed: $error"
fi
```

## Usage in Agent Code

```javascript
import { execSync } from 'node:child_process';

const result = JSON.parse(
  execSync('sol token swap 50 usdc bonk --json').toString()
);

if (result.ok) {
  console.log(`Swapped — tx: ${result.data.signature}`);
} else {
  console.error(`Failed: ${result.error} — ${result.message}`);
}
```
