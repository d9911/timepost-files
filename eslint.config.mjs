import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['dist/**', 'documentation/**', 'node_modules/**'] },
  js.configs.recommended,
  ts.configs.recommended,
  {
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        Response: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        document: 'readonly',
        window: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
);
