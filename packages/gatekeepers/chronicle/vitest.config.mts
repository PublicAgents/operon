import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-chronicle",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // Routing glue over @operon/chronicle, whose suite holds the real
    // specs (queries, mirrors, migrations against real local D1).
    passWithNoTests: true
  }
});
