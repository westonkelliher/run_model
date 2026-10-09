#!/usr/bin/env tsx
// mcp_server: serves a run-model tool set (foo.json + foo.ts pairs) over stdio
// MCP, so a `claude -p` session can call the same local tools the anthropic
// provider runs in-process.  Usage: mcp_server.ts --tools <path> [--tools ...]

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadTools } from "./tools.ts";

const toolPaths: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--tools" && argv[i + 1]) toolPaths.push(argv[++i]);
}
if (toolPaths.length === 0) {
  console.error("usage: mcp_server.ts --tools <path> [--tools <path> ...]");
  process.exit(1);
}

const tools = await loadTools(toolPaths);
const server = new Server({ name: "grim", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools.values()].map((t) => ({
    name: t.definition.name,
    description: t.definition.description ?? "",
    inputSchema: t.definition.input_schema as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.get(req.params.name);
  if (!tool) return { content: [{ type: "text", text: `Error: unknown tool "${req.params.name}"` }], isError: true };
  try {
    const out = await tool.run(req.params.arguments ?? {});
    return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
