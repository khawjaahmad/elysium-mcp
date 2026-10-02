# Contributing

Issues and pull requests are welcome. Report security problems privately, as described in
[SECURITY.md](SECURITY.md), not in a public issue.

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

To point Claude Desktop at a local checkout, use `"command": "node"` and
`"args": ["/absolute/path/to/elysium-mcp/dist/index.js"]` in `claude_desktop_config.json`.

## Development and tests

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

## Secret scanning

To scan the full git history for secrets, run
`docker run --rm -v "$PWD":/repo zricethezav/gitleaks:latest git /repo --log-opts=--all`. It reads
[`.gitleaks.toml`](.gitleaks.toml), which allowlists the published test keys used by the unit tests.

Never commit a real private key, even a testnet one. Test keys must be published dev keys, added to
`.gitleaks.toml` with a comment saying what they are.

## Releasing

Releases are staged on npm by CI from a version tag, and go live only after a maintainer approves them with
2FA. See [RELEASING.md](RELEASING.md).
