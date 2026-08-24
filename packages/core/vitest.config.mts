import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/core",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
