import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import mochaPlugin from 'eslint-plugin-mocha';

export default defineConfig([
  mochaPlugin.configs.recommended,
  {
    rules: {
      'mocha/no-setup-in-describe': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { js },
    extends: ['js/recommended'],
  },
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: globals.node } },
]);
