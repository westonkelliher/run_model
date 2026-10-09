#!/usr/bin/env tsx
// run-model: minimal CLI for running an LLM with local tool definitions.
// Tool convention: foo.json (definition) + foo.ts (implementation) side by side.

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { loadTools, type LoadedTool } from "./tools.ts";

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
  minimax: "MiniMax-M2.5",
  m3: "MiniMax-M3",
  "m2.7": "MiniMax-M2.7",
  "m2.5": "MiniMax-M2.5",
  "m2.1": "MiniMax-M2.1",
};

// MiniMax serves an Anthropic-compatible API, so both providers use the same
// SDK — only baseURL/key differ. MiniMax ignores/rejects output_config, so
// --effort is anthropic-only.
// claude-code runs the loop through `claude -p` (the Claude Code CLI) on the
// logged-in claude.ai account instead of an API key; the tools are served to it
// over stdio MCP by src/mcp_server.ts. No key, no SDK call.
const PROVIDERS: Record<string, { baseURL?: string; apiKeyEnv: string; defaultModel: string }> = {
  anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "opus" },
  "claude-code": { apiKeyEnv: "", defaultModel: "opus" },
  minimax: {
    baseURL: "https://api.minimax.io/anthropic",
    apiKeyEnv: "MINIMAX_API_KEY",
    defaultModel: "minimax",
  },
};

interface Args {
  provider?: string;
  model?: string;
  tools: string[];
  system?: string;
  prompt?: string;
  effort?: string;
  thinking: boolean;
  json: boolean;
  events: boolean;
  maxTokens: number;
  maxTurns: number;
}

function usage(): never {
  console.error(`usage: run-model [flags] [prompt]
  --provider <name>     anthropic|minimax|claude-code (default: inferred from model, else anthropic)
                        claude-code = the Claude Code CLI on the logged-in account (no API key)
  --model <m>           opus|sonnet|haiku|fable or full claude-* id (default: opus);
                        minimax|m3|m2.7|m2.5|m2.1 or full MiniMax-* id
  --tools <path>        tool .json file, or directory of them; repeatable
  --system <text>       system prompt
  --prompt <text>       prompt (alternative to positional arg or stdin)
  --effort <e>          low|medium|high|xhigh|max (anthropic only; not haiku)
  --thinking            enable adaptive thinking; summaries printed to stderr
                        (not supported on haiku)
  --json                print {text, stop_reason, usage, tool_calls} as JSON
  --events              emit JSONL to stdout as each block completes:
                        thinking|text|tool_use|tool_result, then a final "done"
  --max-tokens <n>      default 16000
  --max-turns <n>       agentic loop cap, default 24`);
  process.exit(1);
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function parseArgs(argv: string[]): Args {
  const a: Args = {
    tools: [],
    thinking: false,
    json: false,
    events: false,
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
      case "--events": a.events = true; break;
      case "--max-tokens": a.maxTokens = parseInt(next(), 10); break;
      case "--max-turns": a.maxTurns = parseInt(next(), 10); break;
      case "-h": case "--help": usage();
      default:
        if (arg.startsWith("--")) usage();
        positional.push(arg);
    }
  }
  if (!a.prompt && positional.length > 0) a.prompt = positional.join(" ");
  if (a.effort && !EFFORTS.has(a.effort)) {
    console.error(`run-model: invalid --effort "${a.effort}" (valid: ${[...EFFORTS].join("|")})`);
    process.exit(1);
  }
  return a;
}

// ---- claude-code provider: `claude -p` + stdio MCP tool server ---- //

const CC_SERVER = "grim"; // tools surface to the model as mcp__grim__<name>

async function runClaudeCode(args: Args, model: string, tools: Map<string, LoadedTool>): Promise<number> {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // no key: the CLI must use the account; no nesting guard: we may run inside a Claude Code session
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];

  const mcp = {
    mcpServers: {
      [CC_SERVER]: {
        type: "stdio",
        command: tsx,
        args: [path.join(here, "mcp_server.ts"), ...args.tools.flatMap((t) => ["--tools", path.resolve(t)])],
        env,
      },
    },
  };
  const toolNames = [...tools.keys()].map((n) => `mcp__${CC_SERVER}__${n}`);
  const cli = [
    "-p",
    "--model", model,
    "--output-format", "stream-json", "--verbose",
    "--tools", "",                 // no built-in tools: the model sees only what --tools serves
    "--setting-sources", "",       // no user/project settings, hooks or extra MCP servers
    "--no-session-persistence",
    "--max-turns", String(args.maxTurns),
    "--permission-mode", "bypassPermissions",
    ...(tools.size > 0 ? ["--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--allowedTools", ...toolNames] : []),
    ...(args.system ? ["--system-prompt", args.system] : []),
    ...(args.effort ? ["--effort", args.effort] : []),
  ];
  // cwd outside $HOME so no CLAUDE.md is picked up
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "run-model-cc-"));
  const child = spawn("claude", cli, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(args.prompt);

  const emit = (ev: Record<string, unknown>) => console.log(JSON.stringify(ev));
  const strip = (n: string) => n.startsWith(`mcp__${CC_SERVER}__`) ? n.slice(CC_SERVER.length + 7) : n;
  const toolCallLog: { name: string; input: unknown; result: string; is_error: boolean }[] = [];
  const pendingCalls = new Map<string, { name: string; input: unknown }>();
  let result: any;
  const totalUsage = { input_tokens: 0, output_tokens: 0 };

  const rl = readline.createInterface({ input: child.stdout });
  for await (const line of rl) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          if (args.events) emit({ event: "text", text: block.text });
          else console.error(`[text] ${block.text}`);
        } else if (block.type === "thinking" && block.thinking) {
          if (args.events) emit({ event: "thinking", text: block.thinking });
          else if (args.thinking) console.error(`[thinking] ${block.thinking}`);
        } else if (block.type === "tool_use") {
          const name = strip(block.name);
          pendingCalls.set(block.id, { name, input: block.input });
          if (args.events) emit({ event: "tool_use", name, input: block.input });
          else console.error(`[tool] ${name} ${JSON.stringify(block.input)}`);
        }
      }
      const u = msg.message?.usage;
      if (u) { totalUsage.input_tokens += u.input_tokens ?? 0; totalUsage.output_tokens += u.output_tokens ?? 0; }
    } else if (msg.type === "user") {
      for (const block of msg.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const call = pendingCalls.get(block.tool_use_id) ?? { name: "?", input: null };
        const text = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((c: any) => c.text ?? "").join("\n");
        const isError = !!block.is_error;
        toolCallLog.push({ name: call.name, input: call.input, result: text, is_error: isError });
        if (args.events) emit({ event: "tool_result", name: call.name, result: text, is_error: isError });
        else {
          const shown = text.length > 500 ? `${text.slice(0, 500)}…` : text;
          console.error(`[tool result${isError ? " (error)" : ""}] ${shown}`);
        }
      }
    } else if (msg.type === "result") {
      result = msg;
    }
  }
  const code: number = await new Promise((res) => child.on("close", (c) => res(c ?? 1)));
  fs.rmSync(cwd, { recursive: true, force: true });

  if (!result) {
    console.error(`run-model: claude exited (${code}) without a result`);
    return code || 1;
  }
  const text: string = typeof result.result === "string" ? result.result : "";
  if (result.subtype === "error_max_turns") {
    console.error(`run-model: hit --max-turns (${args.maxTurns}) with the model still working`);
    return 3;
  }
  if (result.is_error) {
    console.error(`run-model: ${text || result.subtype}`);
    return 1;
  }
  const stop_reason = result.stop_reason ?? "end_turn";
  if (args.events) {
    emit({ event: "done", text, model, stop_reason, usage: totalUsage });
  } else if (args.json) {
    console.log(JSON.stringify({ text, model, stop_reason, usage: totalUsage, tool_calls: toolCallLog }, null, 2));
  } else {
    console.log(text);
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve provider/model: explicit --provider wins; otherwise infer minimax
  // from a MiniMax-* model; each provider has its own default model.
  let model = args.model ? MODEL_ALIASES[args.model] ?? args.model : undefined;
  const provider = args.provider ?? (model?.startsWith("MiniMax") ? "minimax" : "anthropic");
  if (provider === "claude-code") model = args.model ?? "opus";
  const providerConf = PROVIDERS[provider];
  if (!providerConf) {
    console.error(`run-model: provider "${provider}" not supported (only: ${Object.keys(PROVIDERS).join(", ")})`);
    process.exit(1);
  }
  model ??= MODEL_ALIASES[providerConf.defaultModel];

  if (provider === "minimax" && args.effort) {
    console.error(`run-model: minimax does not support --effort; ignoring`);
    args.effort = undefined;
  }

  // Haiku 4.5 supports neither output_config.effort nor adaptive thinking —
  // sending either is an API 400, so drop them like the minimax guard above.
  if (model.startsWith("claude-haiku")) {
    if (args.effort) {
      console.error(`run-model: haiku does not support --effort; ignoring`);
      args.effort = undefined;
    }
    if (args.thinking) {
      console.error(`run-model: haiku does not support --thinking (adaptive); ignoring`);
      args.thinking = false;
    }
  }

  if (!args.prompt && !process.stdin.isTTY) {
    args.prompt = fs.readFileSync(0, "utf8").trim();
  }
  if (!args.prompt) usage();

  // Anthropic can also auth via an `ant auth login` profile, so a missing env
  // var is only fatal for other providers.
  const apiKey = providerConf.apiKeyEnv ? process.env[providerConf.apiKeyEnv] : undefined;
  if (!apiKey && provider !== "anthropic" && provider !== "claude-code") {
    console.error(`run-model: ${providerConf.apiKeyEnv} not set (required for provider "${provider}")`);
    process.exit(1);
  }

  const tools = await loadTools(args.tools);
  if (provider === "claude-code") {
    process.exit(await runClaudeCode(args, model, tools));
  }
  const client = new Anthropic({
    ...(providerConf.baseURL ? { baseURL: providerConf.baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
  });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.prompt },
  ];
  const toolCallLog: { name: string; input: unknown; result: string; is_error: boolean }[] = [];
  let response: Anthropic.Message | undefined;
  const totalUsage = { input_tokens: 0, output_tokens: 0 };

  const emit = (ev: Record<string, unknown>) => console.log(JSON.stringify(ev));

  for (let turn = 0; turn < args.maxTurns; turn++) {
    // Stream so large --max-tokens values don't trip the SDK's 10-minute
    // non-streaming guard; finalMessage() gives the same Message shape.
    const stream = client.messages.stream({
      model,
      max_tokens: args.maxTokens,
      ...(args.system ? { system: args.system } : {}),
      // MiniMax accepts adaptive thinking but not the display field (M2.x
      // models think unconditionally either way).
      ...(args.thinking
        ? { thinking: provider === "minimax" ? { type: "adaptive" } : { type: "adaptive", display: "summarized" } }
        : {}),
      ...(args.effort ? { output_config: { effort: args.effort } } : {}),
      ...(tools.size > 0 ? { tools: [...tools.values()].map((t) => t.definition) } : {}),
      messages,
    } as Anthropic.MessageStreamParams);

    // Fires as each content block completes — before the message is done.
    stream.on("contentBlock", (block) => {
      if (block.type === "thinking" && block.thinking) {
        if (args.events) emit({ event: "thinking", text: block.thinking });
        else if (args.thinking) console.error(`[thinking] ${block.thinking}`);
      } else if (block.type === "text") {
        if (args.events) emit({ event: "text", text: block.text });
        else console.error(`[text] ${block.text}`);
      } else if (block.type === "tool_use") {
        if (args.events) emit({ event: "tool_use", name: block.name, input: block.input });
        else console.error(`[tool] ${block.name} ${JSON.stringify(block.input)}`);
      }
    });

    response = await stream.finalMessage();

    totalUsage.input_tokens += response.usage.input_tokens;
    totalUsage.output_tokens += response.usage.output_tokens;

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
        try {
          const out = await tool.run(block.input);
          result = typeof out === "string" ? out : JSON.stringify(out);
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }
      toolCallLog.push({ name: block.name, input: block.input, result, is_error: isError });
      if (args.events) {
        emit({ event: "tool_result", name: block.name, result, is_error: isError });
      } else {
        const shown = result.length > 500 ? `${result.slice(0, 500)}…` : result;
        console.error(`[tool result${isError ? " (error)" : ""}] ${shown}`);
      }
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
  if (response.stop_reason === "pause_turn") {
    console.error(`run-model: hit --max-turns (${args.maxTurns}) with the turn still paused`);
    process.exit(3);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (args.events) {
    emit({
      event: "done",
      text,
      model: response.model,
      stop_reason: response.stop_reason,
      usage: totalUsage,
    });
  } else if (args.json) {
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
