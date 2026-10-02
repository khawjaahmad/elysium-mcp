# Tools

All tools below are read-only; the [write tools](WRITES.md) are separate and off by
default. Inputs are JSON. Integers in outputs are **decimal strings**, because blockchain
integers often exceed JavaScript's safe range. Addresses are returned EIP-55 checksummed.

Wherever an input takes a `block`, it accepts an integer block number or a tag: `latest` (default), `safe`,
`finalized`, `earliest` or `pending`. Where an input takes an `abi`, it accepts:

- a JSON ABI array, or a single ABI item;
- a JSON string of either;
- human-readable signatures, e.g.
  `["function balanceOf(address owner) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"]`.

Contract arguments (`args`) go in order. Integers may be numbers, or decimal / `0x`-hex strings (use strings
above 2^53). Tuples may be arrays or objects keyed by component name.

The optional explorer tools are in [EXPLORER.md](EXPLORER.md), and the optional write tools in
[WRITES.md](WRITES.md). The [error codes](#errors) below cover all of them.

## `get_chain_status`

Latest block, measured block time, base fee and gas price.

| Input        | Type              | Description                                                |
| ------------ | ----------------- | ---------------------------------------------------------- |
| `sampleSize` | integer, optional | Blocks to measure over (default `BLOCK_TIME_SAMPLE_SIZE`). |

**Output**

- `chainId`, `chainName`
- `latestBlock`: `{ number, hash, timestamp, timestampIso, transactionCount, gasUsed, gasLimit }`
- `baseFeePerGas`: `{ wei, gwei }` or `null`
- `gasPrice`: `{ wei, gwei }` (`eth_gasPrice`)
- `blockTime`: `{ averageMs, sampleBlocks, windowSeconds, fromBlock, toBlock }`

Block timestamps have one-second resolution but blocks arrive every 100–200 ms. So `averageMs` is
`windowSeconds × 1000 / sampleBlocks`, and it is `null` if the whole window falls within one second.

## `get_block`

| Input                 | Type                        | Description                                                  |
| --------------------- | --------------------------- | ------------------------------------------------------------ |
| `block`               | integer or string, optional | Number, tag, or 32-byte block hash. Default `latest`.        |
| `includeTransactions` | boolean, optional           | Full transaction objects instead of hashes. Default `false`. |

**Output:** `block` (all fields from the node, integers as decimal strings), `timestampIso`,
`transactionCount`. Any chain-specific extra fields the node returns are passed through unchanged; on
Arbitrum chains these typically include `l1BlockNumber`, `sendRoot` and `sendCount`.

## `get_transaction`

| Input  | Type          | Description                            |
| ------ | ------------- | -------------------------------------- |
| `hash` | string        | Transaction hash (0x + 64 hex).        |
| `abi`  | ABI, optional | Used to decode the call data and logs. |

**Output**

- `status`: `success`, `reverted` or `pending`
- `transactionType`: `{ code, name, origin }`, read from the transaction's raw `type` field.
  - Codes 0–4 are standard Ethereum types sent by users (`origin: "user"`).
  - Codes 100–106 are [Arbitrum's own types](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/rpc-methods):
    bridge deposits and messages from the parent chain (`"bridge"`), retryable redeems (`"retryable"`), and
    ArbOS internal transactions (`"arbos"`).
  - Unrecognised codes give `name: "unknown"`.
- `systemTransaction`: `true` for ArbOS internal transactions (type 106), with a `note`. Every block starts with
  one (`startBlock`, at index 0). No user sends them and they pay no fee, so a zero fee there is expected.
- `transaction`: all transaction fields
- `receipt`: all receipt fields except logs (plus any extras the node adds, such as Arbitrum's `gasUsedForL1`),
  or `null` while pending
- `value`: `{ wei, formatted, symbol }`
- `fee`: `gasUsed × effectiveGasPrice` as `{ wei, formatted, symbol }`; `null` while pending or if the node
  reports no `effectiveGasPrice`
- `decodedInput`: `{ functionName, args }`, `{ error }`, or `null` if no ABI was given or the function isn't in it
- `logs`: array of `{ address, topics, data, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, removed, decoded, decodeError? }`.
  `decoded` is `{ eventName, args }` when the ABI contains the event, otherwise `null`. `decodeError` is
  set when the event name matches but the data doesn't, e.g. an ERC-721 `Transfer` decoded with an
  ERC-20 ABI.

## `get_balance`

| Input     | Type               | Description                         |
| --------- | ------------------ | ----------------------------------- |
| `address` | string             | Account or contract.                |
| `tokens`  | string[], optional | Up to 20 ERC-20 contract addresses. |
| `block`   | optional           | Block to read at.                   |

**Output**

- `address`
- `native`: `{ wei, formatted, symbol: "HYPE" }`
- `tokens`: one entry per token, either `{ token, symbol, decimals, raw, formatted }` or
  `{ token, error: { code, message, retryable, hint? } }`. One bad token does not fail the call.
  `symbol`, `decimals` and `formatted` are `null` if the token doesn't implement them.

## `get_token_info`

| Input   | Type     | Description              |
| ------- | -------- | ------------------------ |
| `token` | string   | ERC-20 contract address. |
| `block` | optional | Block to read at.        |

**Output:** `token`, `name`, `symbol`, `decimals`, `totalSupply: { raw, formatted }`. Any field the
contract doesn't implement is `null`.

**Errors:** `NOT_A_CONTRACT` if the address has no code; `ABI_MISMATCH` if none of the four functions work.

## `read_contract`

Calls a `view` or `pure` function. Nothing is sent to the chain.

| Input          | Type            | Description                                             |
| -------------- | --------------- | ------------------------------------------------------- |
| `address`      | string          | Contract address.                                       |
| `abi`          | ABI             | Must contain the function. A single fragment is enough. |
| `functionName` | string          | Overloads are picked by argument count.                 |
| `args`         | array, optional | Function arguments.                                     |
| `block`        | optional        | Block to read at.                                       |

**Output:** `address`, `functionName`, `signature` (e.g. `balanceOf(address)`), and `result` (the decoded
return value: a single value, an array for several outputs, or an object for structs).

**Errors:** `INVALID_INPUT` for a state-changing function (use `simulate_call`); `ABI_MISMATCH`;
`NOT_A_CONTRACT`; `EXECUTION_REVERTED` with `details.reason`.

## `get_logs`

| Input       | Type                         | Description                                                                                                                  |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `fromBlock` | integer or tag               | First block (inclusive).                                                                                                     |
| `toBlock`   | integer or tag, optional     | Last block (inclusive). Default `latest`.                                                                                    |
| `address`   | string or string[], optional | Emitting contract(s), up to 20.                                                                                              |
| `event`     | string or ABI item, optional | e.g. `Transfer(address indexed from, address indexed to, uint256 value)`. Builds the topic filter and decodes matches.       |
| `args`      | object, optional             | Indexed-parameter values by name, e.g. `{"from": "0x…"}`. An array means "any of"; `null` means "any". Requires `event`.     |
| `topics`    | array, optional              | Raw topic filter instead of `event`: up to 4 positions, each a 32-byte hex value, an array ("any of"), or `null` (wildcard). |
| `abi`       | ABI, optional                | Extra ABI for decoding.                                                                                                      |
| `limit`     | integer, optional            | Maximum logs returned (default 1000, max 10000).                                                                             |

**Output:** `fromBlock`, `toBlock`, `count`, `totalMatched`, `truncated`, and `logs` (same shape as in
`get_transaction`).

**Range limits:** a query with no `address` and no non-null topic (from `event` or `topics`) may cover at most
`MAX_LOG_BLOCK_RANGE` blocks (default 2,000, matching the testnet RPC). A filtered query may cover any range; the
RPC then returns at most 10,000 logs. Ranges are not split automatically.

**Errors:** `RANGE_TOO_LARGE` when an unfiltered range exceeds `MAX_LOG_BLOCK_RANGE`, with a `hint` showing how to
split it or add a filter.

The Elysium testnet RPC also enforces its own limits. These come from the RPC provider, not from Nitro, so they
may change or differ on mainnet. The server recognises the two rejections observed on the testnet (2026-10-02)
and returns them as `RANGE_TOO_LARGE` with the node's own message and limit in `details`:

| `details.reason` | Node message                                                                                                 | Meaning                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `block_range`    | `eth_getLogs block range 9999 exceeds maximum of 2000; narrow fromBlock–toBlock or filter by address/topics` | Unfiltered queries are limited to 2,000 blocks. |
| `too_many_logs`  | `logs count limit exceeded (10000) consider refine/narrow down your query` (code -32005)                     | A query may match at most 10,000 logs.          |

Any other node error stays `RPC_ERROR`, with the node's message.

## `simulate_call`

Dry-runs a transaction with `eth_call` and estimates its gas with `eth_estimateGas`. Nothing is signed or
sent.

| Input                         | Type                        | Description                                                                                     |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `to`                          | string                      | Recipient or contract.                                                                          |
| `from`                        | string, optional            | Sender to simulate as. Set it when the outcome depends on `msg.sender` or the sender's balance. |
| `value`                       | string or integer, optional | HYPE to send, **in wei** (1 HYPE = 10^18 wei).                                                  |
| `data`                        | string, optional            | Raw call data. Use this, or `abi` + `functionName`.                                             |
| `abi`, `functionName`, `args` | optional                    | Encodes the call and decodes the result.                                                        |
| `block`                       | optional                    | State to simulate against.                                                                      |

**Output**

- `success`
- `returnData`
- `decodedResult` (with `abi`)
- `signature`
- `revert`: `{ reason, data, errorName, errorArgs }` when it would revert. `Error(string)`, `Panic(uint256)`
  and custom errors in the supplied ABI are decoded.
- `error`: the node message for other failures, such as insufficient funds
- `gasEstimate`, `gasEstimateError?`
- `gasPrice`
- `estimatedFee`: `gasEstimate × gasPrice`

A call that would fail is a normal result with `success: false`, not a tool error.

## RPC behaviour

- `ELYSIUM_RPC_URL` and `ELYSIUM_CHAIN_ID` have no built-in defaults, so mainnet can be used later without
  code changes. Only the RPC URL's origin is ever logged.
- The chain ID is checked at startup and before the first tool call; a mismatch fails with
  `CHAIN_MISMATCH`.
- Each RPC attempt times out after `RPC_TIMEOUT_MS`. Retries (`RPC_RETRY_COUNT`, after the first attempt)
  happen only for timeouts, connection errors, HTTP 408/429/5xx and JSON-RPC rate-limit errors.
- Backoff is exponential with full jitter from `RPC_RETRY_BASE_DELAY_MS`, capped at 10 s. A `Retry-After`
  header takes precedence.
- `RPC_RATE_LIMIT_RPS` is a client-side token bucket, and retries count against it.
- At the default `MAX_LOG_BLOCK_RANGE` of 2,000 blocks, an unfiltered `get_logs` query covers about
  3–7 minutes at 100–200 ms blocks.

## Errors

Failed tool calls return `isError: true` with a JSON body:

```json
{ "error": { "code": "RANGE_TOO_LARGE", "message": "…", "retryable": false, "hint": "…", "details": {} } }
```

| Code                        | Meaning                                                                               | What the agent should do                                      |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `INVALID_INPUT`             | Malformed input (hash, block, number, argument types, conflicting options).           | Fix the input.                                                |
| `INVALID_ADDRESS`           | Not a 20-byte hex address, or a bad EIP-55 checksum.                                  | Fix the address, or pass it in lowercase.                     |
| `INVALID_ABI`               | The ABI couldn't be parsed.                                                           | Fix the ABI.                                                  |
| `ABI_MISMATCH`              | Function or event not in the ABI, or the contract returned data that doesn't fit it.  | Use the contract's real ABI.                                  |
| `NOT_A_CONTRACT`            | No code at the address.                                                               | Check the address and network.                                |
| `NOT_FOUND`                 | Block or transaction not found, or the explorer has no record (HTTP 404).             | Check the identifier; it may not exist on this network.       |
| `RANGE_TOO_LARGE`           | Log query too wide (local cap or node limit).                                         | Split the range or narrow the filter.                         |
| `EXECUTION_REVERTED`        | A `read_contract` call, or a write's simulation, reverted. A write sends nothing.     | Check the arguments; see `details.reason` / `details.revert`. |
| `RPC_TIMEOUT`               | Node didn't answer in time, after retries.                                            | Retry later (`retryable: true`).                              |
| `RATE_LIMITED`              | Node or explorer rate limited us, after retries (`details.source` says which).        | Wait, then retry (`retryable: true`).                         |
| `RPC_UNAVAILABLE`           | Connection failure or HTTP 5xx, after retries.                                        | Retry later (`retryable: true`).                              |
| `RPC_ERROR`                 | Any other node error.                                                                 | See `message`.                                                |
| `CHAIN_MISMATCH`            | The RPC serves a different chain ID from `ELYSIUM_CHAIN_ID`.                          | Operator must fix the config.                                 |
| `EXPLORER_UNAVAILABLE`      | Explorer timed out, unreachable, or HTTP 5xx, after retries.                          | Retry later (`retryable: true`); use the RPC tools meanwhile. |
| `EXPLORER_RESPONSE_INVALID` | Explorer response wasn't JSON or no longer has the expected shape.                    | The undocumented API probably changed; use the RPC tools.     |
| `EXPLORER_ERROR`            | Explorer rejected the request (HTTP 4xx other than 404/429).                          | See `details.status`.                                         |
| `WRITES_DISABLED`           | A write ran while writes are off (normally the tools are not registered at all).      | Operator must set `ENABLE_WRITES` and `ELYSIUM_PRIVATE_KEY`.  |
| `INSUFFICIENT_FUNDS`        | The sending account can't cover value + maximum fee.                                  | Fund the account or lower the value.                          |
| `NONCE_ERROR`               | The node rejected the nonce (too low, too high, underpriced) and doesn't have the tx. | Check pending transactions (`details.hash`) before retrying.  |
| `VALUE_CAP_EXCEEDED`        | `value` is above `MAX_SEND_HYPE`.                                                     | Send less, or the operator raises the cap.                    |
| `FEE_CAP_EXCEEDED`          | Gas limit × max fee per gas is above `MAX_FEE_HYPE`.                                  | Simplify the call, or the operator raises the cap.            |
| `ADDRESS_NOT_ALLOWED`       | The destination is not in `WRITE_ALLOWLIST`.                                          | Use an allowed address, or the operator updates the list.     |
| `SEND_STATUS_UNKNOWN`       | A signed transaction's send failed and the node may still have received it.           | **Don't retry.** Check `get_transaction` with `details.hash`. |
| `INTERNAL_ERROR`            | Bug in this server.                                                                   | Report it.                                                    |

Errors from schema validation in the MCP SDK (e.g. a number where a string is required) come back as
plain-text `Input validation error: …`.

## Limitations

- **The RPC tools never look up addresses or ABIs.** Callers supply them, or use the optional explorer tools.
- **No Multicall.** Token balances are read with one call per function. That is simple, but slower for
  many tokens at 10 requests/second.
- `get_block` with `includeTransactions: true` returns every transaction in the block, without a cap.
- The HYPE decimals (18) are set once in [`src/chain.ts`](https://github.com/khawjaahmad/elysium-mcp/blob/main/src/chain.ts). This is the EVM convention for
  native coins; Elysium's docs don't state it explicitly.
