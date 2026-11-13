# GitHub App identity

AI code writes use a GitHub App installation token. Git Author and Committer
must also use that App's bot login and numeric bot-user email. Existing history
and personal interactive Git settings are unchanged. A `Verified` signature is
not required for the initial rollout.

Create all new AI PRs as `yepeng-developer[bot]`, using the App's
repository-scoped installation token. The user reviews and merges PRs;
agents must never merge them or enable auto-merge.

## Local credential custody

The private key is stored in Automic Vault as a dedicated Secret. The local
non-secret configuration contains the Client ID, App ID, Installation ID, owner,
repository name and ID, bot login and bot user ID. Start from
`config/github-app.example.json`; keep actual local configuration outside Git.

Import a PEM with `av save --stdin SECRET_NAME < /path/to/key.pem`. Automic
requires human Approval. Preserve the source until a Vault-backed API read has
verified the App identity; then remove the plaintext source. Never print the
PEM, JWT or installation token. A new GitHub App key can replace a lost key;
validate the replacement before revoking the old key in GitHub.

## App session adapter

Node 22.18+ can execute `bin/github-app-session.ts` directly with its built-in
TypeScript support. The credential-bearing code imports only Node built-ins.
Run it from the configured repository, with its credential-free HTTPS `origin`:

Ensure `git`, `gh` and `gh-axi` are on the calling process's `PATH`. GUI agents
can have a different PATH from an interactive terminal. The adapter adds the
directory containing its current Node executable for `gh-axi`'s shebang; it does
not guess a Homebrew or other GitHub CLI installation directory.

### Persistent Automic authorization

For unattended GitHub operations, use environment-mode injection with an exact
Direct Secret Access rule. In Automic Vault, open Secrets, select the dedicated
App key, choose Allow Verified Launcher, and review the actual agent executable
shown as the Verified Launcher in its requests. For Codex, select that signed
`codex` executable, not the Node interpreter or a shell. Approve the policy change
once. Other launchers retain their existing policy.

Direct Access is broad: that Launcher can apply the selected App key to any
Target and arguments through direct injection. It is not restricted to this
adapter or its repository configuration. The adapter still verifies App identity,
issues a token for exactly one repository and revokes it after the command.
These adapter controls do not narrow the underlying Direct Access grant.

```sh
av inject --mode=env +GITHUB_APP_YOUR_APP_PRIVATE_KEY -- \
  /absolute/path/to/node bin/github-app-session.ts \
  --key-env GITHUB_APP_YOUR_APP_PRIVATE_KEY \
  /absolute/path/to/non-secret-config.json --check
```

Use this route for pushes, PR creation and replies once its matching rule has
been reviewed and a real `--check` succeeds without prompting. The adapter
removes the selected environment variable before any subprocess starts; the
child receives only the repository-scoped installation token. Environment
delivery exposes the raw key to the adapter process, so it is a deliberate
custody choice. A missing or empty selected key fails closed without falling
back to FD input or personal credentials. AV may still require review if live
identity, runtime protections or other policy checks fail.

Local commits do not need the App key or an installation token. Use the already
verified bot Author and Committer through process-local Git settings. Keep
personal Git configuration unchanged and batch related authenticated GitHub
operations within one App session.

### Per-invocation human approval

Keep FD delivery when a fresh human decision is desired for every session:

```sh
av inject --mode=fd +YOUR_APP_KEY_SECRET:3 -- \
  /absolute/path/to/node bin/github-app-session.ts \
  /absolute/path/to/non-secret-config.json --check

av inject --mode=fd +YOUR_APP_KEY_SECRET:3 -- \
  /absolute/path/to/node bin/github-app-session.ts \
  /absolute/path/to/non-secret-config.json -- git push origin YOUR_BRANCH

av inject --mode=fd +YOUR_APP_KEY_SECRET:3 -- \
  /absolute/path/to/node bin/github-app-session.ts \
  /absolute/path/to/non-secret-config.json -- gh-axi pr create --help
```

The FD route requires fresh Automic Approval for each invocation, even with a
Direct Access rule or Blessed Script. Both delivery routes use the same adapter:

1. Signs a bounded App JWT and verifies the App and repository installation.
2. Requests a token restricted to exactly the configured repository ID.
3. Verifies the token's effective repository scope, permissions and expiry.
4. Runs Git or GitHub CLI with bot Author / Committer and App credentials.
5. Revokes the token after the command and removes its empty temporary `gh`
   configuration directory. No credentials are written to that directory.

The child receives a scoped token, never the PEM or its file descriptor. This
adapter is for trusted commands, not an execution sandbox. It suppresses
inherited Git/gh authentication tracing, isolates personal credential helpers,
rejects local URL rewrites and extra HTTP headers, verifies `origin`, and limits
the credential helper to the configured GitHub HTTPS repository. Global Git
configuration and personal credentials are not modified.

Each invocation gets a fresh token. A child command has a 45-minute limit;
there is no background refresh service or token cache. A failed session does
not fall back to personal authentication. Hard process termination can prevent
the final revoke; the token's server-side expiry still applies.

## Permissions and limits

Contents and Pull requests write plus Metadata read cover ordinary commits and
PRs. Add Workflows write before committing `.github/workflows` changes. Actions
read supports CI inspection, Checks read supports check runs, and Commit
statuses read supports traditional statuses. The adapter requests these extra
permissions only when the installation already grants them; Actions, Checks
and statuses are limited to read. Actions dispatch requires a separate,
explicitly authorized write-capable path. App permissions do not grant AWS
permissions or authorize deploying reviewed infrastructure.

Start with a selected repository installation. Even if the App is installed on
all repositories, this adapter's token remains restricted to one configured
repository. The underlying private key can apply for other installation tokens,
so the installation scope is still an independent control.

`--check` verifies real App-authenticated `gh auth status`, `gh-axi repo view`
and Git HTTPS reads.
It does not prove push or PR authorship. Validate those with a small bot commit,
App-authenticated push and test PR, then inspect server-side commit identities
and PR author.

## Isolated no-mistakes validation

The adapter accepts `no-mistakes init`, `axi` commands, and the foreground
`daemon run` command only when `NM_HOME` is the `no-mistakes` directory beside
the local App configuration. It rejects managed-service changes and alternate
`--root` arguments. Copy existing non-secret operator settings into that root;
review `forge_profiles` first, because those profiles can deliberately remove
ambient token variables. The shared daemon and its configuration remain separate.

Start the foreground daemon through the App adapter. The daemon must be started
with the App environment; a pre-existing shared daemon does not inherit a new
shell's credentials. The adapter verifies App `gh auth status` before launching
no-mistakes. Inspect its home view before starting a run.

The source-matched AXI home/status/logs queries read local state. AXI run/respond
control the daemon over local IPC and push to the local gate; GitHub publication
belongs to the daemon. Once the operator has verified and started the foreground
App runtime, these local controls do not need the private key or another GitHub
token. Use the configured bot Git identity, isolated NM_HOME and empty personal
Git/gh configuration for the controller. A deliberately unusable credential in
that controller makes unexpected direct GitHub access fail closed; never copy
the daemon's token into it. Use the direct-start safeguard below as well.
The exported `appEnvironment` and `requireNoMistakesDaemon` helpers can prepare
this local invocation without reading key material. An unknown existing daemon
must not be treated as App-authenticated merely because its socket is listening.

The App adapter refuses `axi` when that isolated IPC endpoint is absent. It
also sets the installed no-mistakes version's direct-start escape hatch
`NM_TEST_START_DAEMON=1` for its child: a restart racing the endpoint check must
inherit the App environment, rather than create a managed service with only
HOME/PATH/proxy settings. A directly restarted daemon loses its usable token
when that client session revokes it; restore the foreground App session before
continuing. A listening socket is a liveness check, not proof of authentication.
This integration is pinned to the inspected no-mistakes build `g7a0fdc7` because
it relies on that version's startup contract. A different build fails closed
until its daemon environment and direct-start behavior are reviewed.

Within that isolated runtime, normal Git / gh commands use the inherited App
token and bot Git identity; validation-step agents must not start nested Vault
or pipeline-control sessions. The outer operator must verify resulting commits
and publication actors. Environment markers alone are not proof of identity.
Do not claim worker coverage until that end-to-end validation passes.

Foreground sessions have the same 45-minute limit. Tokens are revoked when the
foreground command exits; a stopped or expired session requires a new App
session, authorized by the selected Vault delivery route. There is no permanent
refresh service. At a pipeline gate, follow no-mistakes custody and recovery
instructions rather than editing its active worktree or bypassing a finding.
Long commands run asynchronously so the parent's network handling remains
responsive. Successful revocation emits a fixed confirmation without the token;
failed cleanup returns a nonzero exit instead of claiming the token was revoked.

For CI jobs that need App code writes, use a separate App key in Actions Secrets
and the official `actions/create-github-app-token` action. Ordinary PR testing
does not need the App key. Do not expose it to untrusted PR code.

References: [App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
[private-key management](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps),
[Automic FD delivery](https://www.automicvault.com/docs/cli/#file-descriptor-delivery),
[Direct Secret Access](https://www.automicvault.com/docs/authority/#direct-secret-access).
