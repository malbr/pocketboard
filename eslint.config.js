import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  URL: "readonly",
  fetch: "readonly",
  Response: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
};
const browserGlobals = {
  document: "readonly",
  window: "readonly",
  fetch: "readonly",
  Response: "readonly",
  crypto: "readonly",
  HTMLFormElement: "readonly",
  React: "readonly",
};

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/migrations/**", "**/playwright-report/**", "**/test-results/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-redeclare": "off",
    },
  },
  {
    files: ["packages/api/**/*.ts", "e2e/playwright.config.ts"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ["packages/web/**/*.ts", "packages/web/**/*.tsx", "e2e/tests/**/*.ts"],
    languageOptions: { globals: browserGlobals },
  },
];
