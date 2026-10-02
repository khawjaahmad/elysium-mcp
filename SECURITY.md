# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[**Report a vulnerability**](https://github.com/khawjaahmad/elysium-mcp/security/advisories/new). You can also
find it under the repository's **Security** tab → **Advisories**.

Please don't open a public issue or pull request for a vulnerability. Include the version, your configuration
(without secrets), steps to reproduce, and what an attacker could achieve. You will get a reply in the
advisory thread, and fixes are credited in the advisory unless you prefer otherwise.

**Never include a private key** in a report, even a testnet one. If you think a key has leaked, move its funds
and stop using it first.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Scope

Especially relevant:

- The private key appearing anywhere: tool output, errors, logs (including the `write-audit` line), or
  anywhere a tool input could extract it.
- A write getting past one of its safety rules:
  - writes disabled;
  - the chain ID check;
  - simulation before sending;
  - the value or fee cap;
  - the allowlist;
  - `dry_run` defaulting to true.
- A write being sent twice, or a retryable error being returned after signing.
- Bypassing the HTTP transport's bearer token or its loopback-only default.

Already known and documented in the [write tools guide](docs/WRITES.md#risks-of-the-write-tools), so not reportable on its
own:

- `WRITE_ALLOWLIST` checks only the transaction's destination, not addresses inside call data.
- Explorer data is untrusted text and can carry prompt injection.
- `dry_run` is not human approval.
- Simulation doesn't guarantee the real transaction succeeds.

This server is unofficial and not affiliated with Kinetiq. Report vulnerabilities in Elysium itself, its
RPC or its explorer to Kinetiq, not here.
