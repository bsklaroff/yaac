import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.frontend.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['..*'], message: 'Relative parent imports are not allowed.' }] },
      ],
      'no-restricted-syntax': ['error', 'ImportExpression'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'avoidEscape' }],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/no-trailing-spaces': ['error'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/commands/**/*'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          // Two sanctioned lib imports: @/lib/k8s/exec (attach/shell/stream
          // spawn `kubectl exec -it` host-side and need the same argv
          // builder the daemon's PTY bridge uses) and @/lib/k8s/cluster-check
          // (`yaac cluster check` diagnoses the local environment directly —
          // routing it through the daemon would hide daemon-down failures).
          // The negation chain re-includes each parent dir (gitignore
          // semantics: a file can't be un-ignored while its parent dir is
          // ignored).
          patterns: [{
            group: [
              '@/*', '!@/commands', '!@/shared',
              '!@/lib', '@/lib/*', '!@/lib/k8s', '@/lib/k8s/*',
              '!@/lib/k8s/exec', '!@/lib/k8s/cluster-check',
            ],
            message: 'src/commands only allowed to import from src/commands, src/shared, @/lib/k8s/exec, or @/lib/k8s/cluster-check',
          }],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [{
            group: ['@/*', '!@/shared'],
            allowTypeImports: true,
            message: 'src/shared only allowed to import types from outside src/shared',
          }],
        },
      ],
    },
  },
)
