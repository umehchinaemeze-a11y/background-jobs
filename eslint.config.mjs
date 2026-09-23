import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "evidence/**"],
  },
  {
    files: ["next-env.d.ts"],
    rules: {
      // Next.js typegen requires a triple-slash reference to ./.next/types.
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },
];

export default eslintConfig;