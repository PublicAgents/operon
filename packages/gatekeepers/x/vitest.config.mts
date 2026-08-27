import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-x",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
