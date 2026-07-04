#!/usr/bin/env tsx
// run-model: minimal CLI for running an LLM with local tool definitions.
// Tool convention: foo.json (definition) + foo.ts (implementation) side by side.

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
};

interface Args {
  provider: string;
  model: string;
  tools: string[];
  system?: string;
  prompt?: string;
  effort?: string;
  thinking: boolean;
  json: boolean;
  maxTokens: number;
  maxTurns: number;
}

function usage(): never {
  console.error(`usage: run-model [flags] [prompt]
  --provider <name>     only "anthropic" supported (default: anthropic)
  --model <m>           opus|sonnet|haiku|fable or full claude-* id (default: opus)
  --tools <path>        tool .json file, or directory of them; repeatable
  --system <text>       system prompt
  --prompt <text>       prompt (alternative to positional arg or stdin)
  --effort <e>          low|medium|high|xhigh|max
  --thinking            enable adaptive thinking; summaries printed to stderr
  --json                print {text, stop_reason, usage, tool_calls} as JSON
  --max-tokens <n>      default 16000
  --max-turns <n>       agentic loop cap, default 24`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    provider: "anthropic",
    model: "opus",
    tools: [],
    thinking: false,
    json: false,
    maxTokens: 16000,
    maxTurns: 24,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage();
      return argv[++i];
    };
    switch (arg) {
      case "--provider": a.provider = next(); break;
      case "--model": a.model = next(); break;
      case "--tools": a.tools.push(next()); break;
      case "--system": a.system = next(); break;
      case "--prompt": a.prompt = next(); break;
      case "--effort": a.effort = next(); break;
      case "--thinking": a.thinking = true; break;
      case "--json": a.json = true; break;
      case "--max-tokens": a.maxTokens = parseInt(next(), 10); break;
      case "--max-turns": a.maxTurns = parseInt(next(), 10); break;
      case "-h": case "--help": usage();
      default:
        if (arg.startsWith("--")) usage();
        positional.push(arg);
    }
  }
  if (!a.prompt && positional.length > 0) a.prompt = positional.join(" ");
  return a;
}

interface LoadedTool {
  definition: Anthropic.Tool;
  run: (input: unknown) => Promise<unknown>;
}

async function loadTool(jsonPath: string): Promise<LoadedTool> {
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

async function loadTools(paths: string[]): Promise<Map<string, LoadedTool>> {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.provider !== "anthropic") {
    console.error(`run-model: provider "${args.provider}" not supported (only: anthropic)`);
    process.exit(1);
  }
  if (!args.prompt && !process.stdin.isTTY) {
    args.prompt = fs.readFileSync(0, "utf8").trim();
  }
  if (!args.prompt) usage();

  const model = MODEL_ALIASES[args.model] ?? args.model;
  const tools = await loadTools(args.tools);
  const client = new Anthropic();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.prompt },
  ];
  const toolCallLog: { name: string; input: unknown; result: string; is_error: boolean }[] = [];
  let response: Anthropic.Message | undefined;
  const totalUsage = { input_tokens: 0, output_tokens: 0 };

  for (let turn = 0; turn < args.maxTurns; turn++) {
    response = await client.messages.create({
      model,
      max_tokens: args.maxTokens,
      ...(args.system ? { system: args.system } : {}),
      ...(args.thinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      ...(args.effort ? { output_config: { effort: args.effort } } : {}),
      ...(tools.size > 0 ? { tools: [...tools.values()].map((t) => t.definition) } : {}),
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);

    totalUsage.input_tokens += response.usage.input_tokens;
    totalUsage.output_tokens += response.usage.output_tokens;

    if (args.thinking) {
      for (const block of response.content) {
        if (block.type === "thinking" && block.thinking) {
          console.error(`[thinking] ${block.thinking}`);
        }
      }
    }

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const tool = tools.get(block.name);
      let result: string;
      let isError = false;
      if (!tool) {
        result = `Error: unknown tool "${block.name}"`;
        isError = true;
      } else {
        console.error(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
        try {
          const out = await tool.run(block.input);
          result = typeof out === "string" ? out : JSON.stringify(out);
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }
      toolCallLog.push({ name: block.name, input: block.input, result, is_error: isError });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  if (!response) throw new Error("no response");
  if (response.stop_reason === "refusal") {
    console.error("run-model: model refused the request");
    process.exit(2);
  }
  if (response.stop_reason === "tool_use") {
    console.error(`run-model: hit --max-turns (${args.maxTurns}) with tool calls still pending`);
    process.exit(3);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (args.json) {
    console.log(JSON.stringify({
      text,
      model: response.model,
      stop_reason: response.stop_reason,
      usage: totalUsage,
      tool_calls: toolCallLog,
    }, null, 2));
  } else {
    console.log(text);
  }
}

main().catch((e) => {
  console.error(`run-model: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
