# Releasing

Releases go out through npm [staged publishing](https://docs.npmjs.com/staged-publishing/):

1. Pushing a `v*` tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml). It refuses a tag
   that doesn't point at a commit on `main`, or that doesn't match the `package.json` version.
2. It runs the format check, typecheck and unit tests, builds, and then runs
   `npm stage publish --access public --provenance`. It authenticates with
   [trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub OIDC), so no npm token is stored
   anywhere.
3. The version now waits in npm's stage queue. Nobody can install it until a maintainer **approves it with
   2FA**. CI can't approve its own release, and the trusted publisher doesn't allow direct `npm publish`.

Requirements (from the npm docs): npm CLI 11.15.0 or newer for `npm stage`, and Node 22.14.0 or newer. The
workflow uses Node 22 and installs `npm@^11.15.0`, because Node 22 ships npm 10.

## Each release

- [ ] In a PR, bump `version` in `package.json` and add a [CHANGELOG.md](CHANGELOG.md) entry. Merge it.
- [ ] Tag `main` and push the tag:
      `git checkout main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
- [ ] Wait for the **Publish** run under Actions to finish green. The version is now staged, not live.
- [ ] **Approve the staged release.** Either way asks for your 2FA code:
  - **On npmjs.com:** open the package → **Staged Packages** tab → check the version and its contents →
    **Approve** → enter the 2FA code.
  - **From the CLI:**

    ```bash
    npm stage list elysium-chain-mcp       # find the stage ID
    npm stage view <stage-id>              # check version, files, provenance
    npm stage download <stage-id>          # optional: inspect the exact tarball
    npm stage approve <stage-id>           # prompts for 2FA, or pass --otp=<code>
    ```

    Before approving, check that the staged version matches the tag. If anything looks wrong, use
    `npm stage reject <stage-id>` instead, and fix it in a new version.

- [ ] Verify the live release:
      `npm view elysium-chain-mcp@X.Y.Z gitHead dist.attestations`. `gitHead` must be the tagged commit, and
      `dist.attestations` must be present. That's the provenance; the npm page also shows a Provenance
      badge.

## One-time setup (done)

These are recorded for reference, or for setting up a fork:

- The repository is public. Provenance only works from a public repository.
- Private vulnerability reporting is enabled (Settings → Security → Advisories). [SECURITY.md](SECURITY.md)
  relies on it.
- The npm trusted publisher: package **Settings** → **Trusted Publisher** → **GitHub Actions**:
  - **Organization or user** `khawjaahmad`, **Repository** `elysium-mcp`, **Workflow filename**
    `publish.yml`.
  - Under **Allowed actions**, `npm publish` is not allowed, so the workflow can only stage.
- No `NPM_TOKEN` secret, and no npm automation token. Recommended: package **Settings** →
  **Publishing access** → **Require two-factor authentication and disallow tokens**. Trusted publishing
  keeps working with it, because it uses OIDC instead of a token.

Notes:

- npm plans to
  [remove direct publishing with bypass-2FA tokens in January 2027](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/).
  This setup doesn't use one.
- Staging a package that didn't exist yet made npm publish a public placeholder version, `0.0.0-stage`.
- `0.1.0` was staged outside this workflow, so it has no provenance attestation. Releases from the workflow
  carry one.
