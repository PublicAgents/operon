import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/chronicle",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
