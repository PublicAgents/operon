import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/ops-tools",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
