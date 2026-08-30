import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@operon/fleet",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
