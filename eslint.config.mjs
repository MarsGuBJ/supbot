import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/release/**", "**/build/**", "**/node_modules/**", "**/.vite/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "packages/**/*.{ts,tsx}",
      "apps/desktop/src/main/**/*.ts",
      "apps/desktop/src/preload/**/*.ts",
      "scripts/**/*.{cjs,js,mjs}",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["**/*.{cjs,js}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
