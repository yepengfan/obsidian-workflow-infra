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
`config/mcp-runtime.json` supplies the literal note prefix, owner Cognito `sub`
allowlist, exact ChatGPT callback URLs, allowed browser origins and limits.
Resource identities and IAM are defined by the CDK modules; GitHub role settings
are in `config/github.json`. No AWS credentials, OAuth secret or token belongs
in these files.

The committed defaults are in [`config/mcp-runtime.json`](../config/mcp-runtime.json);
[`src/config.ts`](../src/config.ts) defines the allowed bounds. Page size, selected
note count, parallel reads, per-note body bytes, chunk bytes, request/response
bytes and tool deadline are bounded independently. The
[Lambda definition](../infra/mcp-runtime.ts) owns the invocation timeout.
Reduce the requested page/selection when a result exceeds the response cap.
No discarded result is represented as a successful complete page.

Logs contain request ID, HTTP status and elapsed time. They omit note paths,
body text, tokens, credentials and raw exception messages. CloudWatch retention
and API throttling are defined in CDK. The runtime has no object-write/delete
permissions and cannot read the ebook or code-artifact bucket.

## Deployment

Run the [local validation commands](../README.md#local-validation), then review
`cdk.out` and the offline CI preview. Follow the deployment prerequisites and
stage advancement in [the rollout guide](mcp-rollout.md#review-and-deployment-order).

The [deployment workflow](github-actions.md#automatic-deployment-run) owns the
Plan artifacts, production approval, exact native-template checks, conditional
immutable ZIP upload and post-Apply verification. Review the templates, native
change-set ARNs and digest before approving production. Stack execution is not
atomic; inspect partially completed runs before retrying.

This implementation has not been deployed as part of code validation. Native
handler permissions, live Cognito OAuth and real ChatGPT compatibility remain
rollout checks requiring the separate concrete deployment approval.

## Owner setup and ChatGPT connection

This private integration uses a predefined confidential OAuth client; it does
not expose dynamic client registration.

1. In Cognito Console, open the pool identified by `ObsidianMcp` outputs and
   create your own user under **Users > Create user**, using your email address.
   Set a temporary password with at least 14 characters, including uppercase,
   lowercase, a number and a symbol. Temporary passwords expire after one day;
   if login is not ready yet, resend/reset the temporary password when connecting.
   After OAuth is configured, complete the password change and required TOTP
   enrollment through managed login. Public signup remains disabled; CI cannot
   create users or administer passwords. Do not send credentials or tokens in
   chat or PRs. The user's Attributes view supplies the non-secret `sub` value
   needed for the owner allowlist. Copy it exactly; Cognito subjects do not need
   to follow an RFC UUID format. The server matches the subject exactly after
   verifying the token and issuer. See the [Cognito subject format guidance](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html).
2. Read `McpEndpoint` and `ChatGptClientId` from the stack outputs. Reveal the
   confidential app client's secret in Cognito Console and enter it directly in
   ChatGPT's custom MCP server configuration. The secret is not in Lambda's
   environment, CI variables, logs or stack outputs.
3. Copy the **exact production callback URI** shown by ChatGPT's MCP management
   page. Do not guess an old callback or use a wildcard. The current official
   format may be callback-specific; the stable callback requires verified issuer
   identification behavior. This server uses native Cognito discovery and does
   not claim or fabricate additional issuer metadata.
4. Add your Cognito user's `sub` to `ownerSubjects` and that exact URI to
   `callbackUrls` in a reviewed configuration PR, then approve its native plan.
   Empty callbacks leave OAuth disabled; an empty owner list denies every note
   request even with an otherwise valid token. No placeholder owner is supplied.
5. Connect the HTTPS `/mcp` URL in ChatGPT with OAuth and the predefined client.
   ChatGPT requests Cognito's advertised OIDC scopes (`openid`, `email`, `phone`,
   `profile`); the client permits these plus `obsidian.notes/read` to avoid an
   `invalid_scope` response. Its readable attribute remains limited to `email`.
   Include `obsidian.notes/read` in the requested scopes; OIDC scopes alone do
   not authorize note access. Use the exact endpoint URL as the OAuth `resource`.
   Sign in through Cognito, completing MFA. Do not request the Cognito user-admin scope or client-credentials
   grant. See the [OpenAI OIDC-scope requirement](https://developers.openai.com/plugins/build/auth#oidc-scopes).

## Connection verification

The public `/.well-known/oauth-protected-resource/mcp` document identifies the
exact `/mcp` resource and native Cognito issuer. Anonymous MCP requests must
return 401 with `WWW-Authenticate` resource metadata, with no S3 reads.

Use the actual ChatGPT connection to browse one root page, choose a returned
folder, list that folder, choose one note, and read it. Ask for body search only
over selected note paths. Confirm the tool list contains exactly the three
read-only tools and returned completion flags/cursors behave as documented.
No test needs to create or edit a private note.

Verify authorization-code + S256 PKCE, reject an incorrect verifier, confirm the
access token's exact resource `aud`, issuer, app-client `client_id`, `token_use:
access`, expiry, read scope and owner `sub`. ID tokens, other clients, other
audiences, expired/bad signatures and other users must be rejected. Check that a
refreshed access token keeps the resource audience and owner restriction.
Inspect token claims locally without posting the token or enabling token logs.

The official SDK uses stateless Streamable HTTP with JSON responses. Each Lambda
invocation creates a fresh server and transport, issues no session ID and closes
after consuming its response. Authenticated GET/DELETE return 405 rather than
holding an SSE stream. Local tests drive the official SDK client across fresh
instances and signed JWT fixtures. That proves local protocol behavior, not a
completed real ChatGPT or Cognito exchange. If the live client fails, inspect
safe request/status logs and fix compatibility without disabling authentication,
weakening audience checks or adding a whole-vault scan.

Sources: [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html),
[Cognito token and refresh behavior](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).
