import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/console",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
