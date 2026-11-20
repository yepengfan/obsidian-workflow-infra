# Obsidian workflow infrastructure

AWS CDK infrastructure for a private Obsidian knowledge base and its staged
ChatGPT and Claude MCP integrations. GitHub holds code and IaC, never notes or
credentials.

## Architecture

The C4 views below describe the intended runtime architecture. Deployment is
staged; see the [rollout guide](docs/mcp-rollout.md#review-and-deployment-order)
for the current stage and prerequisites.

### C1: System context

The owner maintains a private knowledge base and uses ChatGPT or Claude to
discover notes by path, date and size, ask questions about selected notes, write
to the Journal folder, and complete Algorithm and System Design practice with
confirmed saving. System Design
solutions in ChatGPT are drawn in an Excalidraw canvas and reviewed through chat.

```mermaid
flowchart LR
    Owner["Knowledge owner<br/>[Person]"]
    ChatGPT["ChatGPT<br/>[External software system]<br/>Conversational client"]
    Claude["Claude<br/>[External software system]<br/>Conversational client"]
    Platform["Obsidian knowledge platform<br/>[Software system]<br/>Private notes and ebooks"]
    Excalidraw["Excalidraw<br/>[External software system]<br/>Interactive solution canvas"]

    Owner -->|"Asks questions; journals; practices algorithms and system design"| ChatGPT
    Owner -->|"Asks questions, journals and practices"| Claude
    Owner -->|"Maintains knowledge; authorizes access"| Platform
    ChatGPT -->|"Discovers notes by metadata; reads selected notes; writes Journal notes; saves confirmed practice"| Platform
    Claude -->|"Uses the same tools with a separate OAuth client"| Platform
    Owner -->|"Draws and revises the solution"| Excalidraw
    ChatGPT -->|"Opens canvas; checks latest shared drawing"| Excalidraw

    classDef person fill:#08427b,color:#fff,stroke:#052e56
    classDef external fill:#666,color:#fff,stroke:#444
    classDef system fill:#1168bd,color:#fff,stroke:#0b4884
    class Owner person
    class ChatGPT,Claude,Excalidraw external
    class Platform system
```

### C2: Containers

The platform separates authentication, the MCP endpoint, note access, metadata
queries and private storage. C4 containers represent applications and data
stores, not Docker containers.

```mermaid
flowchart TB
    Owner["Knowledge owner<br/>[Person]"]
    ChatGPT["ChatGPT<br/>[External software system]<br/>MCP client"]
    Claude["Claude<br/>[External software system]<br/>MCP client"]
    Excalidraw["Excalidraw<br/>[External software system]<br/>Editable System Design canvas"]

    subgraph Platform["Obsidian knowledge platform [Software system]"]
        Auth["Owner authentication<br/>[Container: Amazon Cognito]<br/>OAuth and MFA; separate app clients"]
        API["MCP endpoint<br/>[Container: API Gateway HTTP API]<br/>HTTPS /mcp"]
        Server["MCP server<br/>[Container: Node.js Lambda]<br/>Stateless TypeScript MCP tools"]
        Vault[("Obsidian vault<br/>[Container: Amazon S3]<br/>Private Markdown notes")]
        Library[("Ebook library<br/>[Container: Amazon S3]<br/>Private ebooks; no MCP access")]
        Logs[("Operational logs<br/>[Container: CloudWatch Logs]<br/>Request status and timing only")]
        Athena["Metadata queries<br/>[Container: Amazon Athena]<br/>Dedicated workgroup; on-demand SQL"]
        Catalog["Metadata catalog<br/>[Container: AWS Glue Data Catalog]<br/>Regional S3 Tables integration"]
        Inventory[("Vault metadata tables<br/>[Container: S3 Metadata / Iceberg]<br/>Live inventory; seven-day journal")]
    end

    Owner -->|"Asks questions, journals and practices"| ChatGPT
    Owner -->|"Asks questions, journals and practices"| Claude
    Owner -->|"Draws the solution"| Excalidraw
    ChatGPT -->|"Renders and reviews current scene<br/>[Host app / widget context]"| Excalidraw
    Owner -->|"Signs in with MFA<br/>[HTTPS]"| Auth
    Owner -->|"Maintains notes<br/>[Obsidian sync]"| Vault
    Owner -->|"Maintains private ebooks"| Library
    ChatGPT -->|"Obtains and refreshes tokens<br/>[OAuth 2.0 / PKCE]"| Auth
    ChatGPT -->|"Discovers notes; reads and saves<br/>[MCP Streamable HTTP / HTTPS]"| API
    Claude -->|"Obtains and refreshes tokens<br/>[OAuth 2.0 / PKCE; Claude client]"| Auth
    Claude -->|"Uses the same MCP tools<br/>[MCP Streamable HTTP / HTTPS]"| API
    API -->|"Invokes handler<br/>[Lambda integration]"| Server
    Server -->|"Fetches signing keys<br/>[HTTPS / JWKS]"| Auth
    Server -->|"Reads notes; writes Journal notes; saves confirmed practice<br/>[S3 API / IAM]"| Vault
    Server -->|"Writes request metadata<br/>[CloudWatch Logs API]"| Logs
    Vault -->|"AWS maintains file metadata<br/>[S3 Metadata]"| Inventory
    Server -->|"Searches paths, dates and sizes<br/>[Athena API / IAM]"| Athena
    Athena -->|"Resolves inventory schema and location<br/>[Glue API / IAM]"| Catalog
    Catalog -.->|"Registers vault namespace and tables"| Inventory
    Athena -->|"Reads live inventory<br/>[S3 Tables / Iceberg]"| Inventory

    classDef person fill:#08427b,color:#fff,stroke:#052e56
    classDef external fill:#666,color:#fff,stroke:#444
    classDef container fill:#438dd5,color:#fff,stroke:#2e6295
    class Owner person
    class ChatGPT,Claude,Excalidraw external
    class Auth,API,Server,Vault,Library,Logs,Athena,Catalog,Inventory container
    style Platform fill:none,stroke:#777,stroke-dasharray:6 4
```

- **Notes:** `list_notes`, `search_notes` and `read_note` browse one folder page
  and read or search only selected notes. The server cannot access the ebook
  library.
- **Metadata search:** optional `search_note_metadata` finds paths by date and
  size through Athena over S3 Metadata, without reading note bodies. See
  [metadata search](docs/metadata-search.md).
- **Journal:** `journal_write` appends to or overwrites Markdown notes under
  `Journal/` only, creating them when absent. See [Journal writes](docs/journal.md).
- **Practice:** Algorithm and System Design coaching with due reviews, and
  confirmed saves limited to approved practice paths. ChatGPT reviews System
  Design solutions in an Excalidraw canvas. See [practice](docs/practice.md).
- **Access:** ChatGPT and Claude each have their own Cognito OAuth client for the
  same MFA-protected owner. See the [connection guide](docs/mcp-server.md).

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

The tool-schema test also needs Python 3 (standard library only). These commands
do not deploy; `synth` writes generated templates to `cdk.out`, which you should
never edit by hand.

## Operational guides

- [Deployment, approvals and permission updates](docs/github-actions.md)
- [Cognito compatibility and OAuth rollout](docs/cognito-preflight.md)
- [Selected-note MCP rollout and permission scope](docs/mcp-rollout.md)
- [Practice workflow, review queues and staged note saving](docs/practice.md)
- [Practice review index: indexer, deployment order and operation](docs/practice-index.md)
- [Journal writes](docs/journal.md)
- [MCP tools, configuration and ChatGPT / Claude connections](docs/mcp-server.md)
- [Athena and S3 Metadata file discovery](docs/metadata-search.md)
- [Storage retention and recovery verification](docs/retention.md)
- [GitHub App identity and credential handling](docs/github-app-identity.md)

## Dependency audit

`npm run audit:ci` (also in CI) fails on any high or critical advisory in runtime
dependencies, then audits the full tree with one build-tool exception. Known,
unresolved findings, none of which are in the Lambda bundle:

- **minimatch inside `aws-cdk-lib`:** two moderate findings. The npm override
  fixes only the separately installed copy.
- **picomatch [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf):**
  high, no upstream patch. Allowed only in [audit-ci.jsonc](audit-ci.jsonc)
  until 2026-12-18 UTC; upgrade and remove the exception once a fix ships.

Do not run `npm audit fix --force`, widen exceptions, or raise the threshold to
silence findings.
