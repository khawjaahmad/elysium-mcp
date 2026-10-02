# Write tools (optional, testnet only)

> **These tools send real transactions from an account you fund.** Read [Risks](#risks-of-the-write-tools)
> before enabling them. New to keys, nonces and gas? See [CONCEPTS.md](CONCEPTS.md#private-keys).

## Setup

1. Create a **dedicated testnet account** that holds only what you can afford to lose, and fund it from the
   [Elysium testnet faucet](https://elysium.kinetiq.xyz/testnet-faucet).
2. Add the write settings to the server's environment, e.g. in `claude_desktop_config.json`:

   ```json
   "env": {
     "ELYSIUM_RPC_URL": "https://testnet-rpc.elysium.kinetiq.xyz",
     "ELYSIUM_CHAIN_ID": "99801",
     "ENABLE_WRITES": "true",
     "ELYSIUM_PRIVATE_KEY": "0x…",
     "MAX_SEND_HYPE": "0.01",
     "MAX_FEE_HYPE": "0.001",
     "WRITE_ALLOWLIST": "0x…,0x…"
   }
   ```

   `MAX_SEND_HYPE` and `MAX_FEE_HYPE` default to the values shown. `WRITE_ALLOWLIST` is optional, and
   `WRITE_RECEIPT_TIMEOUT_MS` (default `30000`) sets how long a send waits for its receipt.

3. Keep **tool-call approval on** in your MCP client for `send_native` and `write_contract`, so a person
   confirms every send. `dry_run` is not that approval: see [Risks](#risks-of-the-write-tools).

## What the server checks

They are registered only when `ENABLE_WRITES=true`. The server then refuses to start unless:

- `ELYSIUM_PRIVATE_KEY` holds a valid key;
- `ELYSIUM_CHAIN_ID` is `99801` (Elysium testnet). This is hard-coded, and every write also checks that
  the node reports `99801` before doing anything;
- over HTTP, `MCP_HTTP_TOKEN` is set.

At startup the server logs a warning with the sending address, the caps and the allowlist, plus a second
warning if the explorer tools are also enabled.

Every write goes through the same steps:

1. **Allowlist** (if `WRITE_ALLOWLIST` is set) and **value cap** (`MAX_SEND_HYPE`).
2. **Chain check**: the node must report chain ID `99801`.
3. **Simulation** with `eth_call` from the sending account. If it reverts, nothing is sent and the tool
   returns `EXECUTION_REVERTED` with the decoded reason.
4. **Gas and fee**: gas limit = `eth_estimateGas` + 20%; refused with `FEE_CAP_EXCEEDED` if
   gas limit × max fee per gas exceeds `MAX_FEE_HYPE`.
5. **Balance**: refused with `INSUFFICIENT_FUNDS` if the account can't cover value + maximum fee.
6. With `dry_run` true (the default), the tool stops here and returns exactly what it would send.
   With `dry_run: false`, it signs (EIP-1559, chain ID `99801`), sends, and waits up to
   `WRITE_RECEIPT_TIMEOUT_MS` for the receipt.

Sends are handled one at a time, so concurrent calls get distinct nonces. Each attempt, including refused
ones and dry runs, writes one `write-audit` line to the log (at `warn` level, so it shows at every
`LOG_LEVEL` except `error`):

```
… WARN write-audit {"tool":"send_native","from":"0x…","to":"0x…","value":"1000","function":null,"dryRun":false,"outcome":"success","hash":"0x…"}
```

`outcome` is `dry_run`, `success`, `reverted`, `pending`, or `error:<CODE>`. The line never contains the key.

## `send_native`

Sends HYPE from the server's account.

| Input     | Type              | Description                                  |
| --------- | ----------------- | -------------------------------------------- |
| `to`      | string            | Recipient.                                   |
| `value`   | string or integer | HYPE to send, **in wei**.                    |
| `dry_run` | boolean, optional | Default `true`: preview only. `false` sends. |

## `write_contract`

Calls a state-changing contract function from the server's account. **The caller supplies the ABI**; the
write tools never fetch one from the explorer.

| Input                         | Type                        | Description                                                             |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `to`                          | string                      | Contract.                                                               |
| `abi`, `functionName`, `args` | required (`args` optional)  | The function to call. `view` and `pure` functions are refused.          |
| `value`                       | string or integer, optional | HYPE to send, in wei. Only `payable` functions accept a non-zero value. |
| `dry_run`                     | boolean, optional           | Default `true`: preview only. `false` sends.                            |

**Output** (both tools)

- `dryRun`, `status`: `dry_run`, `success`, `reverted` (mined but failed on-chain; the fee was still paid),
  or `pending` (sent, no receipt yet: **do not resend**, check `get_transaction` with the hash)
- `hash`: `null` for a dry run
- `transaction`: `{ chainId, from, to, value, data, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxFee }`
- `simulation`: `{ returnData, gasEstimate }`
- `receipt`: `{ blockNumber, gasUsed, effectiveGasPrice, fee }`, or `null`
- `call` (`write_contract` only): `{ functionName, signature, args[{ name, type, value }] }`, decoded back from
  the exact call data, so the caller sees what the transaction really does
- `note`

**Once a transaction is signed, no error is retryable.** A failed request does not prove the node didn't
receive the transaction, and a retry would sign a new one with a fresh nonce: a double send. So when
`eth_sendRawTransaction` fails, the tool:

1. treats "already known" as sent (the node holds this exact transaction, e.g. after a transport-level
   retry);
2. otherwise looks the transaction up by its hash, which is known before sending. If the node has it, the
   tool carries on as if the send succeeded and returns `success`, `reverted` or `pending`. It looks
   after every failure, not only timeouts: a timed-out attempt may have been mined, and the transport's
   retry then gets "nonce too low". A just-accepted transaction may not be visible at once, so it tries
   4 times, 500 ms apart (about 1.5 s);
3. if the node doesn't have it and the failure was a definite rejection (insufficient funds, nonce,
   underpriced, other node errors), returns that code;
4. otherwise (timeout, connection failure, rate limit, or the lookup itself failed) returns
   `SEND_STATUS_UNKNOWN`.

Every such error has `retryable: false` and the hash in `details.hash`. Check `get_transaction` with it
before trying again.

## Risks of the write tools

- **The private key sits in an environment variable.** Anyone who can read the server's environment,
  process list, shell history or `.env` file can take the account. The server removes it from its own
  environment after startup, but the original source (your MCP client config, a `.env` file) still holds it.
  Use a dedicated testnet account holding only what you can afford to lose.
- **`dry_run` is a safeguard against accidents, not a human approval step.** The caller (the agent) can
  set `dry_run: false` itself. Keep **tool-call approval on in your MCP client** for `send_native` and
  `write_contract`, so a person confirms each send.
- **The allowlist and value cap only see the top-level transaction.** `WRITE_ALLOWLIST` checks the address
  called and `MAX_SEND_HYPE` checks the HYPE sent. Neither looks inside the call data. An allowed ERC-20
  contract can still be called with `transfer(anyone, everything)` or `approve(anyone, unlimited)`, and
  both checks pass. **This gap must be closed (by decoding and checking call data) before writes are ever
  enabled on any chain with real value.**
- **A passing simulation does not guarantee success.** Chain state can change between the simulation and
  the send (balances, prices, another transaction landing first). The transaction can then revert on-chain;
  the tool reports `status: "reverted"`, and the fee is still paid.
- **Prompt injection.** On-chain data and explorer text (token names, contract source, decoded inputs) are
  written by third parties. If the explorer tools are enabled alongside writes, such text could try to
  steer the agent into a write. The server logs a warning when both are on. Tool-call approval is the
  defence.
- **Pending is not failed, and unknown is not failed.** `status: "pending"` means the transaction was
  sent; `SEND_STATUS_UNKNOWN` means it may have been. Resending in either case could send twice, so check
  `get_transaction` with the hash first. The tools never mark an error after signing as retryable.
- **One server per key.** Sends are serialised within one process. Two processes sharing a key can pick
  the same nonce; one gets `NONCE_ERROR`.

Errors are listed in [TOOLS.md](TOOLS.md#errors).
