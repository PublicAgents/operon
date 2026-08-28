import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-browser",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
