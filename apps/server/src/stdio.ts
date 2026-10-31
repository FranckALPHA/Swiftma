#!/usr/bin/env node
// Serveur MCP Swiftma en mode Stdio (standard input/output)
// Permet à n'importe quel client MCP (Antigravity, Claude Desktop, Cursor, etc.) de se connecter directement à Swiftma.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { HUB_URL } from "./hub.js";

const token = process.env.SWIFTMA_TOKEN || process.env.SWIFTMA_API_KEY;
const cookie = process.env.SWIFTMA_COOKIE;

const authHeader = token ? (token.startsWith("Bearer ") ? token : `Bearer ${token}`) : undefined;
const creds = { authorization: authHeader, cookie };

async function main() {
  const server = await createMcpServer(creds);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Erreur fatale serveur Swiftma MCP stdio:", err);
  process.exit(1);
});
