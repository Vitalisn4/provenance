import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["app/engines/**", "tests/conformance/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
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
);
