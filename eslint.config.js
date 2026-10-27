import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["app/engines/", "tests/conformance/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "Read configuration through app/config/env.ts only." },
      ],
    },
  },
  {
    files: ["app/config/env.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  // The page runs in the browser; TypeScript checks its names against the DOM types instead.
  {
    files: ["app/ui/page/page.js"],
    rules: { "no-undef": "off" },
  },
  // This file is outside the TypeScript project, so type-aware rules cannot run on it.
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
