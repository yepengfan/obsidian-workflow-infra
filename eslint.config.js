import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['node_modules/**', 'cdk.out/**', 'cdk.storage.out/**', 'cdk.github.out/**', 'cdk.cognito.out/**', 'coverage/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // AWS SDK calls stay in adapters and composition roots; see AGENTS.md.
  { files: ['src/**/*.ts'], ignores: ['src/s3.ts', 'src/athena.ts', 'src/runtime.ts', 'src/artifact-retention.ts', 'src/indexer-runtime.ts', 'src/index-store.ts', 'src/dynamo-review-index.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@aws-sdk/*'], message: 'Depend on a port; keep AWS SDK calls in an adapter.' }] }] } },
);
