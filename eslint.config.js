import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['node_modules/**', 'cdk.out/**', 'cdk.storage.out/**', 'cdk.github.out/**', 'cdk.cognito.out/**', 'coverage/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
