import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: [".next/**", "next-env.d.ts", "data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        ["process", "fetch", "console", "URL", "AbortController", "AbortSignal"].map(name => [name, "readonly"])
      )
    }
  }
];
