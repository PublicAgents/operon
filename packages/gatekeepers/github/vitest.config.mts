import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-github",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
