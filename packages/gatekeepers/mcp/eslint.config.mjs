import baseConfig from "../../../eslint.config.mjs";

export default [
  ...baseConfig,
  {
    files: ["**/*.json"],
    rules: {
      "@nx/dependency-checks": [
        "error",
        {
          ignoredFiles: ["{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}"],
          // The SDK's Worker-safe JSON Schema validator resolves this at
          // runtime as an optional peer; nothing here imports it directly.
          ignoredDependencies: ["@cfworker/json-schema"]
        }
      ]
    },
    languageOptions: {
      parser: await import("jsonc-eslint-parser")
    }
  }
];
