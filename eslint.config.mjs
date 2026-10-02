import js from '@eslint/js';

export default [
  js.configs.recommended,
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
];
