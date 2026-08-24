import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/gatekeeper-deploy",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
