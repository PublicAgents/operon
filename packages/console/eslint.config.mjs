import baseConfig from "../../eslint.config.mjs";

export default [
  ...baseConfig,
  {
    files: ["**/*.json"],
    rules: {
      "@nx/dependency-checks": [
        "error",
        {
          // vitest is a workspace-level dev tool (specs only), never a
          // runtime dependency of the shipped bundle.
          ignoredDependencies: ["vitest"],
          ignoredFiles: [
            "{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}",
            "{projectRoot}/vite.config.ts",
            "{projectRoot}/vitest.config.mts"
          ]
        }
      ]
    },
    languageOptions: {
      parser: await import("jsonc-eslint-parser")
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // The console renders mind output (spec 0005 §8): every HTML
      // injection sink is banned outright. Untrusted strings are text
      // nodes, or they are not rendered.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "banned sink: untrusted content renders as text nodes only (spec 0005 §8)"
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: "banned sink: untrusted content renders as text nodes only (spec 0005 §8)"
        },
        {
          selector: "MemberExpression[property.name='outerHTML']",
          message: "banned sink: untrusted content renders as text nodes only (spec 0005 §8)"
        },
        {
          selector: "MemberExpression[property.name='insertAdjacentHTML']",
          message: "banned sink: untrusted content renders as text nodes only (spec 0005 §8)"
        },
        {
          selector: "MemberExpression[object.name='document'][property.name='write']",
          message: "banned sink: untrusted content renders as text nodes only (spec 0005 §8)"
        }
      ]
    }
  }
];
