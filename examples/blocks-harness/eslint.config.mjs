// The lint every `-blocks` twin runs: @solidjs/eslint-plugin-blocks
// (recommended: every rule an error) plus no explicit `any`.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import blocks from "@solidjs/eslint-plugin-blocks";

export default function blocksConfig(extra = []) {
  return [
    { ignores: ["dist/**", "**/*.gen.d.ts", "node_modules/**"] },
    {
      files: ["src/**/*.{ts,tsx}"],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaFeatures: { jsx: true } },
        ecmaVersion: 2024,
        sourceType: "module"
      },
      plugins: { "@solidjs/blocks": blocks, "@typescript-eslint": tsPlugin },
      rules: {
        ...blocks.configs.recommended.rules,
        "@typescript-eslint/no-explicit-any": "error"
      }
    },
    ...extra
  ];
}
