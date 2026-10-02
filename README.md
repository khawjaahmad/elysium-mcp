# elysium-chain-mcp

> [!IMPORTANT]
> **Testnet only. Unofficial. Not affiliated with Kinetiq.** This is an independent open-source project, not
> made, endorsed or supported by Kinetiq. It is built and tested against the Elysium **testnet** only; mainnet
> has not been published. The optional write tools refuse any chain other than the testnet (chain ID `99801`).

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents read
and interact with **Elysium**, Kinetiq's Layer 2 for Hyperliquid.

Elysium is a standard EVM chain (Arbitrum Orbit / Nitro) with **HYPE** as its gas token. The server gives an
agent typed, rate-limited access through eight read-only RPC tools, seven optional explorer tools, and two
optional testnet write tools that stay off unless the operator enables them.

New to blockchains? [CONCEPTS.md](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/CONCEPTS.md)
explains every concept the server relies on.

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

Claude Desktop: open Settings → Developer → Edit Config, and add this to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

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
`elysium` as connected. Claude Desktop writes server logs to `~/Library/Logs/Claude/mcp-server-elysium.log`
on macOS and to `%APPDATA%\Claude\logs` on Windows.

**3. Ask it something**, for example:

- "What's the latest block on Elysium, and how fast are blocks?"
- "Show me the most recent transaction in that block and what it cost in HYPE."
- "What's the HYPE balance of 0x…?"

## Tools

Full inputs, outputs and error codes:
[TOOLS.md](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/TOOLS.md),
[EXPLORER.md](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/EXPLORER.md) and
[WRITES.md](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/WRITES.md).

| Tool                                | Kind     | What it does                                                          |
| ----------------------------------- | -------- | --------------------------------------------------------------------- |
| `get_chain_status`                  | RPC      | Latest block, measured block time, base fee and gas price.            |
| `get_block`                         | RPC      | A block by number, tag or hash, optionally with full transactions.    |
| `get_transaction`                   | RPC      | A transaction with receipt, fee in HYPE, decoded input and logs.      |
| `get_balance`                       | RPC      | HYPE balance, plus up to 20 ERC-20 balances.                          |
| `get_token_info`                    | RPC      | An ERC-20's name, symbol, decimals and total supply.                  |
| `read_contract`                     | RPC      | Calls a `view` or `pure` function with a caller-supplied ABI.         |
| `get_logs`                          | RPC      | Event logs by address, event or topics, decoded when an ABI is given. |
| `simulate_call`                     | RPC      | Dry-runs a transaction and estimates its gas; nothing is sent.        |
| `explorer_get_address`              | Explorer | Account or contract summary: proxy, creator, indexed balance.         |
| `explorer_get_address_transactions` | Explorer | An address's transaction history, paginated.                          |
| `explorer_get_token_transfers`      | Explorer | An address's token transfers, paginated.                              |
| `explorer_get_token_balances`       | Explorer | Every token the explorer has indexed for an address.                  |
| `explorer_get_contract`             | Explorer | Verification status, ABI and optionally source of a contract.         |
| `explorer_search`                   | Explorer | Search tokens and addresses, with verification and holder counts.     |
| `explorer_get_token`                | Explorer | Token details, optionally with a page of holders.                     |
| `send_native`                       | Write    | Sends HYPE on the testnet. Dry run by default.                        |
| `write_contract`                    | Write    | Calls a state-changing function on the testnet. Dry run by default.   |

Explorer tools need `EXPLORER_API_URL`. They rely on an **undocumented API**, and their text fields can carry
prompt injection, so read [EXPLORER.md](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/EXPLORER.md)
first. Write tools need `ENABLE_WRITES=true`; see [below](#write-tools-safety-summary).

## Environment variables

| Variable                   | Default      | Description                                                                           |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `ELYSIUM_RPC_URL`          | **required** | JSON-RPC endpoint. Testnet: `https://testnet-rpc.elysium.kinetiq.xyz`.                |
| `ELYSIUM_CHAIN_ID`         | **required** | Chain ID the endpoint must serve (testnet `99801`); checked before use.               |
| `ELYSIUM_CHAIN_NAME`       | `Elysium`    | Display name only.                                                                    |
| `RPC_TIMEOUT_MS`           | `10000`      | Timeout per RPC attempt.                                                              |
| `RPC_RETRY_COUNT`          | `3`          | Retries for timeouts, connection errors, 408/429/5xx and rate-limit errors.           |
| `RPC_RETRY_BASE_DELAY_MS`  | `250`        | Base for exponential backoff with jitter; `Retry-After` takes precedence.             |
| `RPC_RATE_LIMIT_RPS`       | `10`         | Client-side RPC requests per second, retries included.                                |
| `MAX_LOG_BLOCK_RANGE`      | `2000`       | Most blocks per unfiltered `get_logs` query; filtered queries have no limit.          |
| `BLOCK_TIME_SAMPLE_SIZE`   | `1000`       | Blocks `get_chain_status` measures block time over.                                   |
| `MCP_TRANSPORT`            | `stdio`      | `stdio` or `http`.                                                                    |
| `MCP_HTTP_HOST`            | `127.0.0.1`  | HTTP bind address.                                                                    |
| `MCP_HTTP_PORT`            | `3000`       | HTTP port.                                                                            |
| `MCP_HTTP_TOKEN`           | unset        | Bearer token (16+ chars); required off loopback, and for writes over HTTP.            |
| `LOG_LEVEL`                | `info`       | `debug`, `info`, `warn` or `error`. Logs go to stderr only.                           |
| `EXPLORER_API_URL`         | unset        | Enables the explorer tools. Testnet: `https://elysium.kinetiq.xyz/api/v2`.            |
| `EXPLORER_TIMEOUT_MS`      | `10000`      | Timeout per explorer request.                                                         |
| `EXPLORER_RETRY_COUNT`     | `2`          | Retries for explorer timeouts, connection errors, 408/429/5xx; honours `Retry-After`. |
| `EXPLORER_RATE_LIMIT_RPS`  | `5`          | Client-side explorer requests per second.                                             |
| `ENABLE_WRITES`            | `false`      | Registers the write tools; needs `ELYSIUM_PRIVATE_KEY` and chain ID `99801`.          |
| `ELYSIUM_PRIVATE_KEY`      | unset        | Key the write tools send from (64 hex chars). Never logged or returned.               |
| `MAX_SEND_HYPE`            | `0.01`       | Most HYPE one write may send, else `VALUE_CAP_EXCEEDED`.                              |
| `MAX_FEE_HYPE`             | `0.001`      | Most one write may cost in fees, else `FEE_CAP_EXCEEDED`.                             |
| `WRITE_ALLOWLIST`          | unset        | Comma-separated destinations; when set, others get `ADDRESS_NOT_ALLOWED`.             |
| `WRITE_RECEIPT_TIMEOUT_MS` | `30000`      | How long a write waits for its receipt before returning `pending`.                    |

### HTTP transport

Start the server with `MCP_TRANSPORT=http` to serve `POST /mcp` (stateless) and `GET /health`
(`{"status":"ok"}`) on `http://127.0.0.1:3000`. With `MCP_HTTP_TOKEN` set, every request needs `Authorization:
Bearer <token>`, compared in constant time. On loopback, requests with a non-loopback `Host` or `Origin` get
403, which blocks DNS rebinding. The server refuses to start off loopback without a token. To connect Claude
Code:

```bash
claude mcp add --transport http elysium http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $MCP_HTTP_TOKEN"
```

## Write tools: safety summary

`send_native` and `write_contract` send real transactions. They are **off by default**, and when enabled:

- They are only registered with `ENABLE_WRITES=true`, and the server refuses to start unless the chain ID is
  `99801`. Every write re-checks the chain ID with the node.
- The key comes only from `ELYSIUM_PRIVATE_KEY`. It is never a tool input, and never logged or returned.
- Every write is simulated first; if the simulation reverts, nothing is sent.
- Each write is capped by `MAX_SEND_HYPE` (value), `MAX_FEE_HYPE` (fee), and, if set, `WRITE_ALLOWLIST`.
- `dry_run` defaults to `true`. Each attempt writes one `write-audit` log line, which never contains the key.
- Once a transaction is signed, no error is retryable, so an agent can't send it twice by retrying.

`dry_run` is **not** human approval: keep tool-call approval on in your MCP client. A passing simulation
doesn't guarantee success. The allowlist and caps don't look inside call data, which **must be fixed before
writes are ever enabled on a chain with real value**. Setup, every check and the full risks list are in
[WRITES.md](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/WRITES.md).

## Links

- [Tools reference and error codes](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/TOOLS.md)
- [Explorer tools and their caveats](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/EXPLORER.md)
- [Write tools: setup and risks](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/WRITES.md)
- [Blockchain concepts](https://github.com/khawjaahmad/elysium-mcp/blob/main/docs/CONCEPTS.md)
- [Changelog](https://github.com/khawjaahmad/elysium-mcp/blob/main/CHANGELOG.md)
- [Contributing: running from source, tests, secret scanning](https://github.com/khawjaahmad/elysium-mcp/blob/main/CONTRIBUTING.md)
- [Security policy](https://github.com/khawjaahmad/elysium-mcp/blob/main/SECURITY.md)
- [Elysium docs](https://elysium.kinetiq.xyz/docs/chain-specifications)

## Licence

[MIT](https://github.com/khawjaahmad/elysium-mcp/blob/main/LICENSE)
