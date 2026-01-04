import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  // Test files - no type checking since they're excluded from tsconfig (must come first)
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Source files with type checking (excludes test files)
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    rules: {
      // Allow explicit any when needed (with eslint-disable comments)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow require imports for dynamic imports (e.g., better-sqlite3)
      '@typescript-eslint/no-require-imports': 'off',
      // Allow unused vars that start with underscore
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // Allow void promises in some contexts (e.g., fire-and-forget)
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Allow promises in useEffect callbacks
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      // Allow unsafe any/assignments in adapter code (better-sqlite3, etc.)
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Allow async functions without await (e.g., adapter wrappers)
      '@typescript-eslint/require-await': 'warn',
    },
  }
);

