import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/container",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
