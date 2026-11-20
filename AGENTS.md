# Project instructions

- Use `yepengfan[bot]` as Author and Committer for all new AI commits. Authenticate GitHub code writes and PR creation through its repository-scoped App session. Follow [the identity guide](docs/github-app-identity.md); stop if App identity cannot be verified. Never fall back to personal credentials.
- The user reviews and merges PRs; agents must never merge them.
- Infrastructure deployment requires the user to review the concrete CDK diff and confirm. Follow [the deployment workflow](docs/github-actions.md).

## Design quality

All code changes must follow SOLID principles:

- **Single responsibility:** separate transport, domain logic, persistence, and configuration when they have different reasons to change.
- **Open/closed:** extend behavior through established module contracts and composition points; keep feature-specific branches out of generic handlers.
- **Liskov substitution:** implementations must preserve their contracts, including error, cancellation, and concurrency semantics.
- **Interface segregation:** depend on narrow capabilities. Separate read and write interfaces instead of adding optional methods that callers must probe.
- **Dependency inversion:** domain logic depends on contracts; concrete adapters are constructed and wired at composition boundaries.

Prefer simple functions and modules. Introduce abstractions when they clarify responsibilities or isolate a concrete dependency.

For nontrivial changes, identify affected responsibilities and dependency direction before implementation. Before declaring work ready, review the complete diff against these rules, fix concrete violations, and run checks appropriate to the change. Briefly explain the design boundaries, validation, and remaining limitations in the PR description.

## MCP runtime layering

Keep each MCP feature in these layers (see `MetadataSearch` / `AthenaMetadataQuery` and `Journal` / `S3NoteStore`):

- **Tool module** (`src/*-tools.ts`): registers tools, schemas and security metadata, and steps up scopes. It calls an application service, never storage.
- **Application service** (`src/metadata-search.ts`, `src/practice.ts`, `src/journal.ts`): path policy and domain rules. Depends only on ports in `src/note-store.ts` or its own query port.
- **Adapter** (`src/s3.ts`, `src/athena.ts`, `src/index-store.ts`): the only place for AWS SDK calls. ESLint rejects `@aws-sdk/*` imports elsewhere in `src/` except composition roots.
- **Composition**: `src/runtime.ts` and `src/indexer-runtime.ts` build adapters; `src/skills.ts` selects enabled skills.

Build scope strings with `requiredScopes` / `writeScope` from `src/auth.ts`. Every write feature reuses the single `/write` scope, and its allowed paths are one exported list shared with IAM synthesis (`practiceWriteResources`, `journalWriteResources`).
