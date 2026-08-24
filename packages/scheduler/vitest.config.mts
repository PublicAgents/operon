import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/scheduler",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
