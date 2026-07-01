// Flat ESLint config (ESLint 9). Lints application + test TypeScript only.
// Vendored data (specs/, knowledge/) and build output (dist/) are excluded.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "specs/**", "knowledge/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // API response bodies are legitimately dynamic; `any` is used deliberately at
      // the HTTP boundary. Keep it visible as a warning rather than a hard error.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow intentionally-unused args/vars when prefixed with underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Empty catch blocks are a deliberate best-effort pattern in a few maintenance scripts.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // Plain Node ESM scripts (build/maintenance) — declare the Node globals they use.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { URL: "readonly", console: "readonly", process: "readonly" },
    },
  },
  // Disable stylistic rules that conflict with Prettier — Prettier owns formatting.
  prettier,
);
