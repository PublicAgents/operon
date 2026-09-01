import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-google-analytics",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
