# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-02

First public release. Testnet only, unofficial, not affiliated with Kinetiq.

### Added

- MCP server for Elysium over stdio and streamable HTTP. Over HTTP, it binds to `127.0.0.1` by default, and a
  bearer token (`MCP_HTTP_TOKEN`) is required when it binds anywhere else.
- Eight read-only RPC tools: `get_chain_status`, `get_block`, `get_transaction`, `get_balance`,
  `get_token_info`, `read_contract`, `get_logs` and `simulate_call`.
  - ArbOS internal transactions (type 106) are flagged as zero-fee system transactions.
  - `get_logs` caps unfiltered queries at 2,000 blocks (`MAX_LOG_BLOCK_RANGE`) and maps the node's range
    and log-count limits to `RANGE_TOO_LARGE`.
- Seven optional explorer tools, enabled by `EXPLORER_API_URL`. They rely on the explorer's undocumented API:
  `explorer_get_address`, `explorer_get_address_transactions`, `explorer_get_token_transfers`,
  `explorer_get_token_balances`, `explorer_get_contract`, `explorer_search` and `explorer_get_token`.
- Two optional write tools for the testnet only, `send_native` and `write_contract`. They are off unless
  `ENABLE_WRITES=true`, and:
  - refuse any chain other than `99801`, checked at startup and before every write;
  - take the key only from `ELYSIUM_PRIVATE_KEY`, never as a tool input, and never log or return it;
  - simulate every transaction first and send nothing if it reverts;
  - cap the value per transaction (`MAX_SEND_HYPE`, default 0.01) and the maximum fee
    (`MAX_FEE_HYPE`, default 0.001);
  - can restrict destinations to an allowlist (`WRITE_ALLOWLIST`);
  - default to `dry_run: true`, and show the decoded function call in a dry run;
  - write one audit log line per attempt;
  - never return a retryable error once a transaction has been signed.
- Typed errors with a stable `code`, a `retryable` flag and a hint.
- RPC rate limiting, retries with backoff, and a chain ID check on first use.
- [docs/CONCEPTS.md](docs/CONCEPTS.md), an introduction to every blockchain concept the server relies on.

[0.1.0]: https://github.com/khawjaahmad/elysium-mcp/releases/tag/v0.1.0
