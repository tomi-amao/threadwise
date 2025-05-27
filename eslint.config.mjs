import js from '@eslint/js';
import globals from 'globals';
import reactPlugin from 'eslint-plugin-react';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
  // Base configuration for all JavaScript files
  js.configs.recommended,
  prettierConfig,
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'public/**',
      '**/.react-router',
    ],
  },
  {
    // Global settings
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      prettier: prettierPlugin,
      react: reactPlugin,
    },
    rules: {
      // Add your custom rules here
      'prettier/prettier': 'error',
      'no-unused-vars': 'warn',
    },
  },
  // React specific settings
  {
    files: ['**/*.jsx', '**/*.tsx'],
    plugins: {
      react: reactPlugin,
    },
    settings: {
      react: {
        version: 'detect', // Automatically detect the React version
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // Not needed with new JSX transform
    },
  },
  // TypeScript specific settings
  ...tseslint.configs.recommended,
];
