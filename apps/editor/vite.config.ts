import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/mcp": server,
      "/ws": { target: server.replace("http", "ws"), ws: true },
    },
  },
});
