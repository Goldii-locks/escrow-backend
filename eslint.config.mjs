import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.mjs",
      "jest.config.js",
      "verify-ci.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Errors: these catch defects tsc does not ───────────────────────────
      //
      // `in` walks the prototype chain. That is precisely how the milestone
      // webhook guard let "toString" through and shipped a payload whose
      // newStatus was a function -- code that type-checked perfectly.
      "no-prototype-builtins": "error",
      "guard-for-in": "error",

      // A dropped `await` in the indexer swallows failures silently.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      "no-useless-catch": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],

      // ── Warnings: pre-existing debt, not worth blocking merges over ────────
      //
      // Turning these into errors today would mean a typing pass over the
      // Stellar SDK call sites in src/routes/jobs.ts. Left visible so the
      // count can come down, rather than hidden so it cannot.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-explicit-any": "warn",

      // Handled by the TypeScript program; the base rule misfires on globals.
      "no-undef": "off",
    },
  },
  {
    files: ["**/*.test.ts", "__tests__/**/*.ts", "jest.setup.ts"],
    rules: {
      // Tests deliberately poke at loosely-typed mocks.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
