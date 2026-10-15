// Service MCP/IA de Nyota : serveur MCP (IA externes) et agent intégré « capture d'écran → design ».
// Il travaille sur les fichiers du hub (Rust) par son API ; le hub lui relaie /mcp et /api/ai/*.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { type DesignRequest, runDesignAgent } from "./agent.js";
import { HUB_URL, credentialsKey, credentialsOf, hubClient } from "./hub.js";
import { resolveFile } from "./files.js";

const PORT = Number(process.env.PORT ?? 4001);
const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/api/ai/health", (_req, res) => res.json({ ok: true, agent: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) }));

// Agent intégré : capture d'écran et/ou texte → design. Le résultat arrive en direct dans l'éditeur (via le hub).
app.post("/api/ai/design", async (req, res) => {
  const body = req.body as DesignRequest & { fileId?: string };
  try {
    const creds = credentialsOf(req.headers);
    const hub = hubClient(creds);
    const fileId = await resolveFile(hub, await credentialsKey(creds), body.fileId);
    const text = await runDesignAgent(hub, fileId, body, (event) => void hub.postEvent(fileId, event).catch(() => {}));
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// MCP en HTTP « streamable », sans état : un serveur + un transport par requête.
app.post("/mcp", async (req, res) => {
  const server = await createMcpServer(credentialsOf(req.headers));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => {
  console.log(`Nyota MCP/IA   → http://localhost:${PORT} (hub : ${HUB_URL})`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("ANTHROPIC_API_KEY absent : l'agent intégré est désactivé (MCP fonctionne).");
});
