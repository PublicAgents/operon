import { execFileSync } from "node:child_process";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev mode proxies the API, MCP, and WebSocket paths to a real deployed
 * ops gateway (OPERON_OPS_URL), injecting a short-lived Access JWT from
 * `cloudflared access token` the same way tools/tail-wake.mjs does. No
 * auth-bypass flag exists in the worker: dev talks to the real,
 * Access-gated colony (fail closed, nothing to forget to remove).
 */
function accessToken(ops: string): string {
  try {
    return execFileSync("cloudflared", ["access", "token", "--app", ops], {
      encoding: "utf8"
    }).trim();
  } catch {
    console.warn(`no Access session for ${ops}; run: cloudflared access login ${ops}`);
    return "";
  }
}

function proxyConfig(): Record<string, ProxyOptions> {
  const ops = process.env.OPERON_OPS_URL;
  if (!ops) return {};
  let token = accessToken(ops);
  const shared: ProxyOptions = {
    target: ops,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", request => {
        if (token) request.setHeader("cf-access-jwt-assertion", token);
      });
      // A dev session outlasts the short-lived JWT: refresh on a 401.
      proxy.on("proxyRes", response => {
        if (response.statusCode === 401) token = accessToken(ops);
      });
    }
  };
  return {
    "/api": shared,
    "/mcp": shared,
    "/whoami": shared,
    "/openapi.json": shared,
    "/ws": { ...shared, ws: true }
  };
}

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: { proxy: proxyConfig() }
});
