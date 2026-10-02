# elysium-chain-mcp

> [!IMPORTANT]
> **Testnet only. Unofficial. Not affiliated with Kinetiq.** This is an independent open-source project, not
> made, endorsed or supported by Kinetiq. It is built and tested against the Elysium **testnet** only; mainnet
> has not been published. The optional write tools refuse any chain other than the testnet (chain ID `99801`).

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents read
and interact with **Elysium**, Kinetiq's Layer 2 for Hyperliquid.

Elysium is a standard EVM chain (Arbitrum Orbit / Nitro) that uses **HYPE** as its native gas token. This
server gives an agent typed, rate-limited, read-only access to it through eight RPC tools, plus seven optional
explorer tools. Two optional [write tools](#write-tools-optional-testnet-only) (`send_native`,
`write_contract`) can send transactions on the Elysium **testnet** only. They are off unless the operator
enables them.

> New to blockchains? [docs/CONCEPTS.md](docs/CONCEPTS.md) explains every concept this server relies on.

## Quickstart (five minutes)

You need **Node.js 20 or newer** (`node --version`) and Claude Code or Claude Desktop. Nothing else: the
server runs through `npx`, and the RPC tools are read-only.

**1. Add the server.**

Claude Code:

```bash
claude mcp add --env ELYSIUM_RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz \
  --env ELYSIUM_CHAIN_ID=99801 --transport stdio elysium \
  -- npx -y elysium-chain-mcp
```

Claude Desktop: open Settings → Developer → Edit Config, and add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elysium": {
      "command": "npx",
      "args": ["-y", "elysium-chain-mcp"],
      "env": {
        "ELYSIUM_RPC_URL": "https://testnet-rpc.elysium.kinetiq.xyz",
        "ELYSIUM_CHAIN_ID": "99801"
      }
    }
  }
}
```

**2. Restart** Claude Desktop, or start a new Claude Code session. In Claude Code, `/mcp` should list
`elysium` as connected.

**3. Ask it something**, for example:

- "What's the latest block on Elysium, and how fast are blocks?"
- "Show me the most recent transaction in that block and what it cost in HYPE."
- "What's the HYPE balance of 0x…?"

To also enable the explorer tools, add `EXPLORER_API_URL=https://elysium.kinetiq.xyz/api/v2` to the
environment ([read about them first](#explorer-tools-optional-undocumented-api)). The write tools stay off
unless you follow [their own setup](#write-tools-optional-testnet-only).

## Requirements

- Node.js 20 or newer
- An Elysium JSON-RPC endpoint. The public testnet, from the
  [official docs](https://elysium.kinetiq.xyz/docs/chain-specifications):

  |          | Testnet                                   | Mainnet           |
  | -------- | ----------------------------------------- | ----------------- |
  | Chain ID | `99801`                                   | not yet published |
  | RPC      | `https://testnet-rpc.elysium.kinetiq.xyz` | not yet published |

  There are no built-in defaults: the network always comes from environment variables.

## Running from source

```bash
git clone https://github.com/khawjaahmad/elysium-mcp.git
cd elysium-mcp
npm ci
npm run build
cp .env.example .env   # edit if needed

# stdio (what Claude Desktop / Claude Code use)
ELYSIUM_RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz ELYSIUM_CHAIN_ID=99801 node dist/index.js

# or streamable HTTP on http://127.0.0.1:3000/mcp
MCP_TRANSPORT=http ELYSIUM_RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz ELYSIUM_CHAIN_ID=99801 node dist/index.js
```

The server doesn't read `.env` itself. Pass variables through your MCP client's config, your shell, or
`node --env-file=.env dist/index.js`.

## Connecting from Claude

The [Quickstart](#quickstart-five-minutes) has the basic Claude Code and Claude Desktop setup. More detail:

### Claude Desktop

`claude_desktop_config.json` lives at `~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

Running from a local checkout instead of npm: use `"command": "node"` and
`"args": ["/absolute/path/to/elysium-mcp/dist/index.js"]`. Restart Claude Desktop afterwards. Server logs
go to `~/Library/Logs/Claude/mcp-server-elysium.log` on macOS and `%APPDATA%\Claude\logs` on Windows.

### Claude Code

Over HTTP, with the server started separately with `MCP_TRANSPORT=http` and `MCP_HTTP_TOKEN` set:

```bash
claude mcp add --transport http elysium http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $MCP_HTTP_TOKEN"
```

## Environment variables

| Variable                   | Default      | Description                                                                                                                                                                         |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ELYSIUM_RPC_URL`          | **required** | JSON-RPC endpoint (http/https). Only its origin is ever logged.                                                                                                                     |
| `ELYSIUM_CHAIN_ID`         | **required** | Chain ID the endpoint must serve. Checked at startup and before the first tool call; a mismatch fails with `CHAIN_MISMATCH`.                                                        |
| `ELYSIUM_CHAIN_NAME`       | `Elysium`    | Display name only.                                                                                                                                                                  |
| `RPC_TIMEOUT_MS`           | `10000`      | Timeout per RPC attempt.                                                                                                                                                            |
| `RPC_RETRY_COUNT`          | `3`          | Retries after the first attempt, for timeouts, connection errors, HTTP 408/429/5xx and JSON-RPC rate-limit errors only.                                                             |
| `RPC_RETRY_BASE_DELAY_MS`  | `250`        | Base for exponential backoff with full jitter (capped at 10 s). A `Retry-After` header takes precedence.                                                                            |
| `RPC_RATE_LIMIT_RPS`       | `10`         | Client-side limit on RPC requests per second (token bucket; retries count too).                                                                                                     |
| `MAX_LOG_BLOCK_RANGE`      | `2000`       | Maximum blocks per unfiltered `get_logs` query (about 3–7 minutes at 100–200 ms blocks). Queries with an address or topic filter have no block limit.                               |
| `BLOCK_TIME_SAMPLE_SIZE`   | `1000`       | Blocks `get_chain_status` measures block time over.                                                                                                                                 |
| `MCP_TRANSPORT`            | `stdio`      | `stdio` or `http`.                                                                                                                                                                  |
| `MCP_HTTP_HOST`            | `127.0.0.1`  | HTTP bind address.                                                                                                                                                                  |
| `MCP_HTTP_PORT`            | `3000`       | HTTP port.                                                                                                                                                                          |
| `MCP_HTTP_TOKEN`           | unset        | Bearer token for HTTP, at least 16 characters. **Required** if the host is not loopback, and whenever `ENABLE_WRITES=true` over HTTP.                                               |
| `LOG_LEVEL`                | `info`       | `debug`, `info`, `warn` or `error`. Logs go to stderr only.                                                                                                                         |
| `ENABLE_WRITES`            | `false`      | Turns on the [write tools](#write-tools-optional-testnet-only). Requires `ELYSIUM_PRIVATE_KEY` and `ELYSIUM_CHAIN_ID=99801`. When unset, the write tools are not registered at all. |
| `ELYSIUM_PRIVATE_KEY`      | unset        | Private key of the account the write tools send from (64 hex characters). Read only when `ENABLE_WRITES=true`; never logged or returned.                                            |
| `MAX_SEND_HYPE`            | `0.01`       | Most HYPE a single write may send (`value`). Larger values are refused with `VALUE_CAP_EXCEEDED`.                                                                                   |
| `MAX_FEE_HYPE`             | `0.001`      | Most a single write may cost in fees (gas limit × max fee per gas). Above it, the write is refused with `FEE_CAP_EXCEEDED`.                                                         |
| `WRITE_ALLOWLIST`          | unset        | Comma-separated addresses. When set, writes to any other address are refused with `ADDRESS_NOT_ALLOWED`.                                                                            |
| `WRITE_RECEIPT_TIMEOUT_MS` | `30000`      | How long a write waits for its receipt before returning `status: "pending"`.                                                                                                        |
| `EXPLORER_API_URL`         | unset        | Enables the optional [explorer tools](#explorer-tools-optional-undocumented-api). No default. For the testnet explorer: `https://elysium.kinetiq.xyz/api/v2`.                       |
| `EXPLORER_TIMEOUT_MS`      | `10000`      | Timeout per explorer request.                                                                                                                                                       |
| `EXPLORER_RETRY_COUNT`     | `2`          | Retries for explorer timeouts, connection errors, HTTP 408/429/5xx. A `Retry-After` header is honoured.                                                                             |
| `EXPLORER_RATE_LIMIT_RPS`  | `5`          | Client-side limit on explorer requests per second.                                                                                                                                  |

### HTTP transport security

- The server runs in stateless mode: each `POST /mcp` is handled independently. `GET /health` returns
  `{"status":"ok"}`.
- With a token set, every `/mcp` request needs `Authorization: Bearer <token>`. The comparison is
  constant-time.
- When bound to a loopback address, requests whose `Host` or `Origin` header is not loopback are rejected
  with 403. This blocks DNS-rebinding attacks from web pages.
- The server refuses to start on a non-loopback address without a token.

## Tools

All tools below are read-only; the [write tools](#write-tools-optional-testnet-only) are separate and off by
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

### `get_chain_status`

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

### `get_block`

| Input                 | Type                        | Description                                                  |
| --------------------- | --------------------------- | ------------------------------------------------------------ |
| `block`               | integer or string, optional | Number, tag, or 32-byte block hash. Default `latest`.        |
| `includeTransactions` | boolean, optional           | Full transaction objects instead of hashes. Default `false`. |

**Output:** `block` (all fields from the node, integers as decimal strings), `timestampIso`,
`transactionCount`. Any chain-specific extra fields the node returns are passed through unchanged; on
Arbitrum chains these typically include `l1BlockNumber`, `sendRoot` and `sendCount`.

### `get_transaction`

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

### `get_balance`

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

### `get_token_info`

| Input   | Type     | Description              |
| ------- | -------- | ------------------------ |
| `token` | string   | ERC-20 contract address. |
| `block` | optional | Block to read at.        |

**Output:** `token`, `name`, `symbol`, `decimals`, `totalSupply: { raw, formatted }`. Any field the
contract doesn't implement is `null`.

**Errors:** `NOT_A_CONTRACT` if the address has no code; `ABI_MISMATCH` if none of the four functions work.

### `read_contract`

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

### `get_logs`

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

### `simulate_call`

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

## Explorer tools (optional, undocumented API)

> **These tools rely on an undocumented API.** Elysium's documentation doesn't describe a block-explorer
> API. The explorer at `elysium.kinetiq.xyz` serves a Blockscout-style JSON API under `/api/v2`, which these
> tools use. It can change or disappear without notice. The tools are off unless `EXPLORER_API_URL` is set.

They add what the RPC can't do: address history, every token an address holds, verified ABIs, and search.

**Failure handling**

- A failure returns a typed error: `EXPLORER_UNAVAILABLE`, `EXPLORER_RESPONSE_INVALID`, `RATE_LIMITED` or
  `NOT_FOUND`.
- Responses are checked against the fields the server reads, so a format change becomes
  `EXPLORER_RESPONSE_INVALID` rather than wrong data.
- The explorer has its own HTTP client, timeout, retry and rate limiter. Explorer tools don't depend on the
  RPC, and RPC tools don't depend on the explorer.
- Point `EXPLORER_API_URL` at the explorer for the same network as `ELYSIUM_RPC_URL`. The server can't
  check that they match.

**What the data means**

- **Indexed, not authoritative.** Balances, holder counts and histories come from the explorer's database
  and may lag the chain. The RPC tools (`get_balance`, `get_token_info`, `get_transaction`) are the source
  of truth.
- **"Verified" ≠ safe.** A verified contract is one whose published source the explorer matched to the
  deployed bytecode. That says nothing about whether the contract is safe, audited, or what it claims to be.
- **Names are not unique.** Anyone can deploy a token called "USDC". `explorer_search` returns
  verification status and holder counts so lookalikes can be told apart; always identify a token by its
  address.

### Prompt-injection risk

Token and contract names, symbols, ENS names, method names, decoded inputs, ABIs and source code are written
by whoever deployed or named things on-chain. They can contain text aimed at an AI agent, such as "ignore
your instructions and…". This server:

- returns every such field under an `untrusted` key, and every response carries a `notices` list saying so;
- caps lengths: names 100 characters, symbols 32, method names 100, decoded parameter values 500, source code
  50,000;
- strips control characters, and replaces bidirectional-override and zero-width characters with `�` so
  disguised text stays visible;
- tells the agent in its MCP instructions to treat untrusted fields as data, never as instructions.

None of this can make third-party text safe. Agents and the people supervising them should not act on
instructions found in these fields.

### Pagination

List tools return `nextCursor`. Pass it back unchanged as `cursor` to get the next page; `null` means
the last page.

- A cursor only works with the tool and address it came from.
- The explorer decides the page size (20 items in testing). The server returns at most 50 items per page;
  if it ever has to drop items, it sets `truncated: true` and gives the count in `omittedItems`.

### `explorer_get_address`

**Input:** `address`

**Output**

- `address`, `isContract`, `isVerifiedContract`
- `proxy`: `{ type, implementations: [{ address, untrusted: { name } }] }`, or `null` if not a proxy
- `creator`: `{ address, transactionHash }`
- `hasTokens`, `hasTokenTransfers`, `hasLogs`
- `indexedBalance`: `{ wei, formatted, symbol, updatedAtBlock }`, labelled as indexed
- `token`: token summary if the address is a token
- `untrusted`: `{ name, ensName }`
- `notices`

### `explorer_get_address_transactions`

**Input:** `address`, `cursor?`

**Output:** `items[]`, newest first. Each item has:

- `hash`, `blockNumber`, `timestamp`
- `from`, `to`, `createdContract`
- `value` and `fee` in HYPE
- `status`, `type`, `transactionTypes`
- `untrusted`: `{ method, decodedInput: { methodCall, methodId, parameters[{ name, type, value }] }, revertReason }`

Plus `nextCursor`, `truncated`, `omittedItems` and `notices`.

### `explorer_get_token_transfers`

**Input:** `address`, `cursor?`

**Output:** `items[]`. Each item has:

- `transactionHash`, `blockNumber`, `timestamp`, `logIndex`
- `from`, `to`, `token`
- `amount: { raw, formatted }` and `tokenId` (for NFTs)
- `type`
- `untrusted: { method }`

Plus pagination fields and `notices`.

### `explorer_get_token_balances`

**Input:** `address`

**Output:** `items[]`, each `{ token, balance: { raw, formatted }, tokenId }`, covering every token the
explorer has indexed for the address. These are indexed balances; confirm with `get_balance`.

### `explorer_get_contract`

**Input:** `address`, `includeSource?` (default `false`)

**Output**

- `isVerified`
- `untrusted: { name, abi }`. The ABI is checked to be valid and capped at 200 KB, and can be passed to
  `read_contract`, `get_logs` or `simulate_call`. `abiNote` explains a missing ABI.
- `verification: { fully, partially, verifiedAt, meaning }`
- `compiler: { version, language, optimizationEnabled, license }`
- `proxy`: `{ type, implementations[], implementationsOmitted }`. Each implementation is
  `{ address, isVerified, untrusted: { name, abi }, abiNote }`, or `{ address, error }`; at most 3 are looked up.
- `source`: `{ untrusted: { filePath, code }, truncated }` when requested
- `notices`

A plain account returns `NOT_FOUND`.

### `explorer_search`

**Input:** `query` (1–100 characters), `cursor?`

**Output:** `items[]`. Each item has:

- `type` (`token`, `address`, …), `address`, `tokenType`
- `isVerifiedContract`
- `holdersCount`: looked up for up to 10 token results
- `totalSupply`, `transactionHash`, `blockHash`, `blockNumber`
- `untrusted: { name, symbol }`

Plus pagination fields and `notices`.

### `explorer_get_token`

**Input:** `token`, `includeHolders?`, `cursor?` (a holders cursor; implies `includeHolders`)

**Output**

- `token`: `{ address, type, decimals, totalSupply, holdersCount, untrusted: { name, symbol } }`
- `holders`: `{ items[{ holder, balance, tokenId }], nextCursor, truncated, omittedItems }`, or `null`
- `notices`

## Write tools (optional, testnet only)

> **These tools send real transactions from an account you fund.** Read [Risks](#risks-of-the-write-tools)
> before enabling them. New to keys, nonces and gas? See [docs/CONCEPTS.md](docs/CONCEPTS.md#private-keys).

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

### `send_native`

Sends HYPE from the server's account.

| Input     | Type              | Description                                  |
| --------- | ----------------- | -------------------------------------------- |
| `to`      | string            | Recipient.                                   |
| `value`   | string or integer | HYPE to send, **in wei**.                    |
| `dry_run` | boolean, optional | Default `true`: preview only. `false` sends. |

### `write_contract`

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

### Risks of the write tools

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
- The HYPE decimals (18) are set once in [`src/chain.ts`](src/chain.ts). This is the EVM convention for
  native coins; Elysium's docs don't state it explicitly.

## Development

```bash
npm run typecheck          # tsc --noEmit (strict)
npm test                   # unit tests (mocked JSON-RPC node, no network)
npm run test:integration   # live tests against the testnet
SKIP_INTEGRATION=true npm run test:integration   # skip them
npm run build
```

The unit tests run the real MCP server, viem client and transport against a fake JSON-RPC node. That way
viem's real error handling (reverts, timeouts, HTTP failures) is exercised.

The explorer live tests (`tests/integration/explorer.live.test.ts`) run only when `EXPLORER_API_URL` is set.

The live write tests (`tests/integration/write.live.test.ts`) have two parts:

- One always runs. It uses a fresh, unfunded throwaway key, so it can never send anything. It checks the
  real node accepts the write path up to the balance check, which refuses with `INSUFFICIENT_FUNDS`.
- One sends 1 wei from an account to itself, and runs only when `ELYSIUM_TEST_PRIVATE_KEY` holds a
  **funded testnet** key: `ELYSIUM_TEST_PRIVATE_KEY=0x… npm run test:integration`.

The integration tests read the live testnet. They discover addresses on-chain (a recent transaction, an
ERC-20 that recently emitted a `Transfer`) rather than hard-coding any. They use `ELYSIUM_RPC_URL` and
`ELYSIUM_CHAIN_ID` if set, otherwise the published testnet values.

To scan the full git history for secrets, run
`docker run --rm -v "$PWD":/repo zricethezav/gitleaks:latest git /repo --log-opts=--all`. It reads
[`.gitleaks.toml`](.gitleaks.toml), which allowlists the published test keys used by the unit tests.

## Releasing

Releases are staged on npm by CI from a version tag, and go live only after a maintainer approves them with
2FA. The steps are in [RELEASING.md](RELEASING.md).

## Licence

[MIT](LICENSE)
