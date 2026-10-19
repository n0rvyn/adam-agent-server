import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const API_PROXY_TARGET = "http://127.0.0.1:7100";
const WS_PROXY_TARGET = "ws://127.0.0.1:7100";
const apiProxyPrefixes = [
  "/audit",
  "/auth",
  "/channels",
  "/chat",
  "/config",
  "/delivery-rules",
  "/evolution-audit",
  "/fs",
  "/goals",
  "/healthz",
  "/memories",
  "/plugins",
  "/readyz",
  "/roles",
  "/stats",
  "/strategies",
  "/task-templates",
  "/tasks",
  "/version",
  "/webhooks",
  "/template-executions",
];

export default defineConfig({
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-dom/") || id.includes("node_modules/react/") || id.includes("node_modules/react-router")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/zustand/")) {
            return "vendor-state";
          }
          if (id.includes("node_modules/lucide-react/")) {
            return "vendor-icons";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/events": {
        target: WS_PROXY_TARGET,
        ws: true,
      },
      "/chat/stream": {
        target: WS_PROXY_TARGET,
        ws: true,
      },
      ...Object.fromEntries(
        apiProxyPrefixes.map((prefix) => [
          prefix,
          { target: API_PROXY_TARGET },
        ]),
      ),
    },
  },
});
