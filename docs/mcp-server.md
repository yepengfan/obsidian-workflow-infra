# Private Obsidian MCP server

The runtime is an owner-only reader for Markdown notes in the configured private
S3 Vault. Neither GitHub nor the code-artifact bucket contains notes. S3 stays
private; no public objects or presigned note URLs are generated.

## Tools and retrieval

| Tool | Input and scope |
| --- | --- |
| `list_notes` | One explicit `folder`, optionally `limit` and returned `cursor`. Empty folder means root children. One S3 page, delimiter `/`, no body reads or recursion. |
| `search_notes`, filename | `mode: "filename"`, explicit folder and literal query. Filters one metadata page, with a continuation cursor and completion flag. |
| `search_notes`, body | `mode: "body"`, nonempty selected `paths` and a literal query. Reads only that bounded batch in parallel; never expands folders. |
| `search_note_metadata` (when enabled) | Literal path text, explicit folder and descendants, optional UTC date/byte-size ranges. Queries S3 Metadata through Athena without body reads. Continue pending executions or later pages with unchanged filters and the returned cursor. See [metadata search](metadata-search.md). |
| `read_note` | One selected Markdown `path`, optionally the returned cursor. Reads a bounded UTF-8 chunk, pinned to the object's ETag while continuing. |

Results use MCP `structuredContent` and output schemas. Paths are stable resource
identifiers the caller can choose, not capabilities or filesystem paths. This
works through ordinary tools without requiring ChatGPT's optional MCP Resources
support. Notes are untrusted source data, never instructions for the assistant.

Every result declares its scope and whether it is complete. Continue only when
useful to the current question. A filename miss on an incomplete page does not
mean the folder has no match. Body search reports oversized/unavailable notes
separately rather than claiming no match. Use chunked reads for an oversized
selected note. There is no scan-all mode, recursive enumeration, automatic
widening, index or scheduled background reader.

Paths reject absolute paths, backslashes, empty/dot segments, control characters,
non-Markdown reads, and S3 keys over 1,024 bytes. Cursors are opaque, untrusted
pagination inputs bound to the user and request context. They are not signed
credentials and cannot replace JWT authorization. Changing a note invalidates
its read continuation; restart that selected note.

## Configuration and bounds

`config/storage.json` supplies account, Region and Vault bucket.
`config/mcp-runtime.json` supplies the literal note prefix, Cognito owners group
name, separate exact ChatGPT (`callbackUrls`) and Claude (`claudeCallbackUrls`)
callback allowlists, allowed browser origins and limits. An empty Claude callback
list omits its app client and branding; the existing ChatGPT client remains stable.
CDK manages the group structure; user accounts and membership are application
access data managed in Cognito, without Git changes or infrastructure deployment.
Resource identities and IAM are defined by the CDK modules; GitHub role settings
are in `config/github.json`. No AWS credentials, OAuth secret or token belongs
in these files.

The canonical MCP endpoint is also the Cognito resource-server identifier. Its
read scope is `<McpEndpoint>/read`, exported as `NotesScope`; use the exact output
instead of a friendly scope prefix. Cognito requires custom scopes in a
resource-bound request to belong to the requested resource. The runtime, public
metadata, OAuth challenge and client all use this same URL-bound scope.

The committed defaults are in [`config/mcp-runtime.json`](../config/mcp-runtime.json);
[`src/config.ts`](../src/config.ts) defines the allowed bounds. Page size, selected
note count, parallel reads, per-note body bytes, chunk bytes, request/response
bytes and tool deadline are bounded independently. The
[Lambda definition](../infra/mcp-runtime.ts) owns the invocation timeout.
Reduce the requested page/selection when a result exceeds the response cap.
No discarded result is represented as a successful complete page.

Logs contain request ID, HTTP status and elapsed time. Rejected authentication or
request-origin checks also include a fixed `denialReason`: `authentication`,
`owner_group`, or `origin_or_host`. They omit actual origins, hosts, token claims,
note paths, body text, tokens, credentials and raw exception messages. CloudWatch
retention and API throttling are defined in CDK. Runtime writes are limited to
enabled practice paths; it cannot delete objects or read the ebook or
code-artifact bucket.

## Deployment

Run the [local validation commands](../README.md#local-validation), then review
`cdk.out` and the offline CI preview. Follow the deployment prerequisites and
stage advancement in [the rollout guide](mcp-rollout.md#review-and-deployment-order).

The [deployment workflow](github-actions.md#automatic-deployment-run) owns the
Plan artifacts, production approval, exact native-template checks, conditional
immutable ZIP upload and post-Apply verification. Review the templates, native
change-set ARNs and digest before approving production. Stack execution is not
atomic; inspect partially completed runs before retrying.

The resource-bound scope migration requires separately approved deployment;
code validation does not activate it. Live Cognito OAuth and real ChatGPT
compatibility remain [connection checks](#connection-verification) after Apply.

## Owner setup and ChatGPT connection

Each host uses its own predefined confidential OAuth client; the server does
not expose dynamic client registration.

1. In Cognito Console, open the pool identified by `ObsidianMcp` outputs and
   select your existing owner user. If you do not yet have one, create your own
   user under **Users > Create user**, using your email address. For a new user,
   set a temporary password with at least 14 characters, including uppercase,
   lowercase, a number and a symbol. Temporary passwords expire after one day;
   if login is not ready yet, resend/reset the temporary password when connecting.
   After OAuth is configured, complete the password change and required TOTP
   enrollment through managed login. Public signup remains disabled; CI cannot
   create users or administer passwords. Do not send credentials or tokens in
   chat or PRs. No user `sub`, email or membership is stored in infrastructure
   configuration. See [connection verification](#connection-verification) for
   subject and group-claim requirements.
2. Read `McpEndpoint` and `ChatGptClientId` from the stack outputs. Reveal the
   confidential app client's secret in Cognito Console and enter it directly in
   ChatGPT's custom MCP server configuration. The secret is not in Lambda's
   environment, CI variables, logs or stack outputs.
3. Copy the **exact production callback URI** shown by ChatGPT's MCP management
   page. Do not guess an old callback or use a wildcard. The current official
   format may be callback-specific; the stable callback requires verified issuer
   identification behavior. This server uses native Cognito discovery and does
   not claim or fabricate additional issuer metadata.
4. Verify that `callbackUrls` in the committed configuration matches that URI;
   the owner's callback is already configured. A changed callback requires a
   reviewed configuration PR; empty callbacks leave OAuth disabled. Keep the
   CDK-managed `ownerGroup` name. Follow the
   [runtime deployment order](mcp-rollout.md#runtime-stage) for the separately
   approved IAM prerequisite before merge/ordinary CI Plan, then production Apply.
5. After successful Apply, open **Groups** in the same Cognito user pool, select
   the group named by the `OwnerGroupName` stack output, and add your existing
   user. Wait for CDK to create the group; do not create it manually.
   An empty group grants nobody note access.
   CI creates the group structure but cannot create users or change membership.
6. Connect the HTTPS `/mcp` URL in ChatGPT with OAuth and the predefined client.
   ChatGPT requests Cognito's advertised OIDC scopes (`openid`, `email`, `phone`,
   `profile`); the client permits these plus the `NotesScope` output to avoid an
   `invalid_scope` response. Its attribute reads are limited to `email`,
   `email_verified`, `phone_number` and `phone_number_verified`, matching the
   `email` and `phone` scopes; attribute writes remain limited to `email`.
   Cognito can reject authorization-code exchange with `invalid_grant` when
   requested scopes lack their required attribute reads, including when `email`
   is readable but `email_verified` is not. See the
   [Cognito token endpoint errors](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html#token-endpoint-negative).
   Include that exact URL-formatted read scope; OIDC scopes alone do
   not authorize note access. Use the exact endpoint URL as the OAuth `resource`.
   Sign in through Cognito, completing MFA. Do not request the Cognito user-admin scope or client-credentials
   grant. See the [OpenAI OIDC-scope requirement](https://developers.openai.com/plugins/build/auth#oidc-scopes).

When upgrading an existing connection from the legacy `obsidian.notes/read`
scope, wait for approved Apply, refresh the MCP connection metadata in ChatGPT,
and replace any manually saved legacy default scope with `NotesScope`. Reconnect
through OAuth to obtain a new token. Keep the existing callback URI configured;
creating another connection can produce a different callback that needs review.

Review the [scope-registry migration](mcp-rollout.md#resource-bound-read-scope-migration)
in the native plan before approving Apply. Existing user accounts and owners-group
membership need no reassignment.

## Claude connection

Claude uses the same HTTPS MCP endpoint and Cognito owner account, with a separate
`obsidian-claude` confidential app client. Its client ID, secret, callback and
refresh sessions are independent of ChatGPT's. The pool, MFA, owners group,
resource audience and read/write scope checks are shared. Creating another app
client grants no additional vault permissions or access to other users.

1. Review and deploy the PR through the normal Plan / production Apply workflow.
   `claudeCallbackUrls` must contain exactly
   `https://claude.ai/api/mcp/auth_callback`. Keep ChatGPT's `callbackUrls` unchanged.
   CDK adds `ClaudeClient` and `ClaudeLoginBranding`, exports `ClaudeClientId`, and
   sets Lambda's `OAUTH_CLIENT_IDS` to the explicit deployed client IDs. No secret
   is exported or stored in Lambda. The existing execution-role policy already
   covers these resource types in the managed pool; no IAM expansion is needed.
   `OAUTH_CLIENT_ID` retains ChatGPT's ID for the previous Lambda code during
   CloudFormation's separate configuration/code updates. New code uses that
   single-client fallback only when `OAUTH_CLIENT_IDS` is absent, never when the
   new allowlist is malformed.
2. In Claude, open **Customize > Connectors > Add custom connector**. Enter
   **Name:** `Obsidian`, and **MCP server URL:** the exact `McpEndpoint` stack
   output, including `/mcp`. Click **Continue** and review detected authentication.
3. Select **Sign in now** and **Use your own OAuth client**. Enter `ClaudeClientId`
   from the stack outputs. In Cognito Console, open the same user pool, select
   **App clients > obsidian-claude**, reveal its client secret, and enter it
   directly into Claude. Leave fixed request headers empty. Dynamic client
   registration and Claude's published client identity are not configured here.
4. Click **Add**, then **Connect**, and complete Cognito login and MFA with the
   existing owner account. Do not add the owner to another group. Enable the
   connector for the conversation through **+ > Connectors**.
   Requests that include an `Origin` header must also pass the independent
   `allowedOrigins` check. The committed configuration explicitly permits
   `https://chatgpt.com` and `https://claude.ai`; an approved OAuth callback alone
   does not allow an origin. Unknown origins remain rejected before note access.
5. Verify a root listing and a selected note read, then enabled metadata / practice
   tools. For confirmed practice saving, the token also needs the resource-bound
   write scope. Claude must request the canonical `McpEndpoint` as OAuth `resource`
   so Cognito issues the exact access-token audience. Missing audience or scopes
   fail closed; do not relax validation to make a host connect.

The deployment checker tests each configured client's callbacks without login.
It does not prove Claude's actual code exchange, PKCE, audience or refresh flow;
complete the connection checks below after approved Apply. Existing ChatGPT
connections should continue using their current client ID, secret and callback.
The Excalidraw app available inside ChatGPT is a separate host integration; adding
this connector gives Claude MCP tools without provisioning that app in Claude.

See [Claude's custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
for the current connector UI and redirect URI.

## Connection verification

The public `/.well-known/oauth-protected-resource/mcp` document identifies the
exact `/mcp` resource and native Cognito issuer. Anonymous MCP requests must
return 401 with `WWW-Authenticate` resource metadata, with no S3 reads.

The [post-deployment public checker](cognito-preflight.md#local-checks-and-post-deployment-discovery)
checks resource-bound authorization parameters before login. It does not prove
the user's complete OAuth exchange.

Use each enabled host connection to browse one root page, choose a returned
folder, list that folder, choose one note, and read it. Ask for body search only
over selected note paths. Confirm the tool list contains the three ordinary
note tools plus any enabled [practice tools](practice.md), and that returned
completion flags/cursors behave as documented. Refresh the connection metadata
after an approved deployment to load updated tool definitions.
No test needs to create or edit a private note.

Verify authorization-code + S256 PKCE, reject an incorrect verifier, confirm the
access token's exact resource `aud`, issuer, allowlisted app-client `client_id`,
`token_use: access`, expiry, read scope and exact owners-group membership in the
signed `cognito:groups` array. ID tokens, clients outside the deployed allowlist,
other audiences, expired/bad signatures, missing/malformed groups (including
mixed-type arrays) and nonmembers
must be rejected before S3 access. Group names are case-sensitive, with no trimming
or normalization. Subjects must be nonempty strings of at most 2,048 characters,
without normalization or UUID validation.
Different user subjects with authorized membership are accepted; pagination
remains bound to each subject. Check that refreshed access tokens reflect current
membership and preserve the resource audience and read scope.
Inspect token claims locally without posting the token or enabling token logs.

Membership changes need no infrastructure deployment. Reconnect to obtain fresh
tokens after a change. Already-issued access tokens remain valid until their
15-minute expiry; removing membership does not immediately invalidate them.

The official SDK uses stateless Streamable HTTP with JSON responses. Each Lambda
invocation creates a fresh server and transport, issues no session ID and closes
after consuming its response. Authenticated GET/DELETE return 405 rather than
holding an SSE stream. Local tests drive the official SDK client across fresh
instances and signed JWT fixtures. That proves local protocol behavior, not a
completed real ChatGPT or Cognito exchange. If the live client fails, inspect
safe request/status logs and fix compatibility without disabling authentication,
weakening audience checks or adding a whole-vault scan.

The runtime reserves ten concurrent Lambda executions and uses the same API
Gateway burst target so overlapping discovery and handshake requests can
complete. The steady-state gateway rate remains two requests per second.
If refresh intermittently fails and public metadata returns 503, inspect
Lambda `Throttles` and `ConcurrentExecutions`
alongside the configured reserved concurrency. Confirm the live metadata burst
again after an approved capacity update; a successful single request does not
establish reliable refresh behavior.
For metadata 429 responses, check the
[API Gateway stage and regional rate/burst targets](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html).

Sources: [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html),
[Cognito group claims](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html),
[Cognito token and refresh behavior](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).
