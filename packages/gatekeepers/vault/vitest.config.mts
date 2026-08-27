import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-vault",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
