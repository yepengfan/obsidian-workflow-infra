# Obsidian workflow infrastructure

AWS CDK infrastructure for a private Obsidian knowledge base and its staged
ChatGPT MCP integration. GitHub holds code and IaC, never notes or credentials.

## Architecture

The C4 views below describe the intended runtime architecture. Deployment is
staged; see the [rollout guide](docs/mcp-rollout.md#review-and-deployment-order)
for the current stage and prerequisites.

### C1: System context

The owner maintains a private knowledge base and uses ChatGPT to ask questions
about selected notes.

```mermaid
flowchart LR
    Owner["Knowledge owner<br/>[Person]"]
    ChatGPT["ChatGPT<br/>[External software system]<br/>Conversational client"]
    Platform["Obsidian knowledge platform<br/>[Software system]<br/>Private notes and ebooks"]

    Owner -->|"Asks questions"| ChatGPT
    Owner -->|"Maintains knowledge; authorizes access"| Platform
    ChatGPT -->|"Authenticates and retrieves selected notes"| Platform

    classDef person fill:#08427b,color:#fff,stroke:#052e56
    classDef external fill:#666,color:#fff,stroke:#444
    classDef system fill:#1168bd,color:#fff,stroke:#0b4884
    class Owner person
    class ChatGPT external
    class Platform system
```

### C2: Containers

The platform separates authentication, the MCP endpoint, note retrieval and
private storage. C4 containers represent applications and data stores, not
Docker containers.

```mermaid
flowchart TB
    Owner["Knowledge owner<br/>[Person]"]
    ChatGPT["ChatGPT<br/>[External software system]<br/>MCP client"]

    subgraph Platform["Obsidian knowledge platform [Software system]"]
        Auth["Owner authentication<br/>[Container: Amazon Cognito]<br/>OAuth and MFA"]
        API["MCP endpoint<br/>[Container: API Gateway HTTP API]<br/>HTTPS /mcp"]
        Server["MCP server<br/>[Container: Node.js Lambda]<br/>Stateless TypeScript MCP tools"]
        Vault[("Obsidian vault<br/>[Container: Amazon S3]<br/>Private Markdown notes")]
        Library[("Ebook library<br/>[Container: Amazon S3]<br/>Private ebooks; no MCP access")]
        Logs[("Operational logs<br/>[Container: CloudWatch Logs]<br/>Request status and timing only")]
    end

    Owner -->|"Signs in with MFA<br/>[HTTPS]"| Auth
    Owner -->|"Maintains notes<br/>[Obsidian sync]"| Vault
    Owner -->|"Maintains private ebooks"| Library
    ChatGPT -->|"Obtains and refreshes tokens<br/>[OAuth 2.0 / PKCE]"| Auth
    ChatGPT -->|"Calls read-only tools<br/>[MCP Streamable HTTP / HTTPS]"| API
    API -->|"Invokes handler<br/>[Lambda integration]"| Server
    Server -->|"Fetches signing keys<br/>[HTTPS / JWKS]"| Auth
    Server -->|"Lists metadata; reads selected notes<br/>[S3 API / IAM]"| Vault
    Server -->|"Writes request metadata<br/>[CloudWatch Logs API]"| Logs

    classDef person fill:#08427b,color:#fff,stroke:#052e56
    classDef external fill:#666,color:#fff,stroke:#444
    classDef container fill:#438dd5,color:#fff,stroke:#2e6295
    class Owner person
    class ChatGPT external
    class Auth,API,Server,Vault,Library,Logs container
    style Platform fill:none,stroke:#777,stroke-dasharray:6 4
```

The application implements `list_notes`, `search_notes`, and `read_note`.
ChatGPT browses one folder page, chooses note paths, then retrieves or searches
only those notes. There is no whole-vault scan, recursive traversal or index.
The MCP server has read-only access to the vault and no access to the ebook
library. See the [connection guide](docs/mcp-server.md#owner-setup-and-chatgpt-connection)
for owner authorization and OAuth setup.

Keep these C1 and C2 views aligned with changes to the system's users,
integrations, applications and data stores. Authoritative definitions and
settings live in the [CDK app](bin/infrastructure.ts),
[infrastructure modules](infra/), and [versioned configuration](config/).

## Local validation

Use Node 22.18 or newer within Node 22:

```sh
npm ci
npm run check
npm run synth
```

Synthesis writes the cloud assembly for the configured stage to `cdk.out`;
these commands do not deploy. Edit the TypeScript/configuration sources, never
generated templates.

## Operational guides

- [Deployment, approvals and permission updates](docs/github-actions.md)
- [Cognito compatibility and OAuth rollout](docs/cognito-preflight.md)
- [Selected-note MCP rollout and permission scope](docs/mcp-rollout.md)
- [MCP tools, configuration and ChatGPT connection](docs/mcp-server.md)
- [Storage retention and recovery verification](docs/retention.md)
- [GitHub App identity and credential handling](docs/github-app-identity.md)

## Dependency audit

The pinned CDK library bundles a vulnerable minimatch copy, currently reported
as two moderate findings (minimatch and aws-cdk-lib). The npm override fixes the
separately installed copy, not the bundled one. CDK remains a build-time dependency and is not bundled into the Lambda runtime. Do not use
`npm audit fix --force` to silently downgrade CDK or claim the bundled finding
is resolved. Recheck upstream before publishing.
