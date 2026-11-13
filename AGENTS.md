# Project instructions

- All new AI commits and GitHub code writes must use the configured GitHub App identity. Follow [the identity guide](docs/github-app-identity.md); stop if App authentication fails. Never fall back to personal credentials.
- Create PRs as `yepeng-ai-developer[bot]`. The user reviews and merges; agents must never merge PRs.
- Infrastructure deployment requires the user to review the concrete CDK diff and confirm. Follow [the deployment workflow](docs/github-actions.md).
