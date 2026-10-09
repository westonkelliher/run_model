// tool loading shared by run-model (in-process loop) and mcp_server (claude-code provider)
import type Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface LoadedTool {
  definition: Anthropic.Tool;
  run: (input: unknown) => Promise<unknown>;
}

export async function loadTool(jsonPath: string): Promise<LoadedTool> {
  const definition = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  for (const field of ["name", "description", "input_schema"]) {
    if (!(field in definition)) {
      throw new Error(`${jsonPath}: missing required field "${field}"`);
    }
  }
  const tsPath = jsonPath.replace(/\.json$/, ".ts");
  if (!fs.existsSync(tsPath)) {
    throw new Error(`${jsonPath}: no sibling implementation ${tsPath}`);
  }
  const mod = await import(pathToFileURL(tsPath).href);
  if (typeof mod.default !== "function") {
    throw new Error(`${tsPath}: must default-export a function (input) => result`);
  }
  return { definition, run: mod.default };
}

export async function loadTools(paths: string[]): Promise<Map<string, LoadedTool>> {
  const jsonFiles: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (fs.statSync(resolved).isDirectory()) {
      for (const f of fs.readdirSync(resolved)) {
        if (f.endsWith(".json")) jsonFiles.push(path.join(resolved, f));
      }
    } else {
      jsonFiles.push(resolved);
    }
  }
  const tools = new Map<string, LoadedTool>();
  for (const f of jsonFiles) {
    const tool = await loadTool(f);
    if (tools.has(tool.definition.name)) {
      throw new Error(`duplicate tool name "${tool.definition.name}" from ${f}`);
    }
    tools.set(tool.definition.name, tool);
  }
  return tools;
}
