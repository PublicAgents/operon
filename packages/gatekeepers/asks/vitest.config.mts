import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-asks",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
