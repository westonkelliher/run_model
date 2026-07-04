# run-model

Minimal CLI for running an LLM with local tool definitions. Handles the full
agentic loop (model calls tool → tool runs locally → result fed back) and
prints the final answer. Installed as `run-model` on PATH (shim in `~/bin`).

## Usage

```sh
run-model [flags] "your prompt"
echo "your prompt" | run-model [flags]        # prompt via stdin also works
```

| Flag | Meaning | Default |
|---|---|---|
| `--model <m>` | `opus` \| `sonnet` \| `haiku` \| `fable`, or any full `claude-*` id | `opus` |
| `--tools <path>` | A tool `.json` file, or a directory of them. Repeatable. | none |
| `--system <text>` | System prompt | none |
| `--prompt <text>` | Prompt (alternative to positional/stdin) | — |
| `--effort <e>` | `low`\|`medium`\|`high`\|`xhigh`\|`max` (not supported on haiku) | API default (`high`) |
| `--thinking` | Enable adaptive thinking; summaries print to **stderr** (not on haiku) | off |
| `--json` | Print `{text, model, stop_reason, usage, tool_calls}` JSON | plain text |
| `--max-tokens <n>` | Per-response output cap | 16000 |
| `--max-turns <n>` | Agentic loop cap | 24 |
| `--provider <p>` | Only `anthropic` for now | `anthropic` |

## Defining a tool

A tool is two files with the same basename, side by side:

**`my_tool.json`** — Anthropic tool definition:
```json
{
  "name": "my_tool",
  "description": "What it does and when the model should call it.",
  "input_schema": {
    "type": "object",
    "properties": { "arg": { "type": "string", "description": "..." } },
    "required": ["arg"]
  }
}
```

**`my_tool.ts`** — implementation. Must default-export a function taking the
input object and returning a string (or anything JSON-stringifiable). Throwing
sends the error message back to the model as a tool error.
```ts
export default async function myTool(input: { arg: string }): Promise<string> {
  return `did something with ${input.arg}`;
}
```

`--tools dir/` loads every `.json` in the directory (each needs its sibling
`.ts`). See `tools/word_count.{json,ts}` in this repo for a working example.

## Output & exit codes

- Final model text → **stdout**. Tool-call traces and thinking → **stderr**.
- Exit `0` success · `1` usage/API error · `2` model refused · `3` hit `--max-turns`.
- For scripting, use `--json` and parse stdout.

## Auth

Needs `ANTHROPIC_API_KEY` in the environment (or an `ant auth login` profile —
the SDK resolves either). **There is currently no key configured on this
machine**; the command will fail with "Could not resolve authentication
method" until one is set.

## Example

```sh
run-model --model sonnet --tools ~/bin/model_tools \
  --system "You are a build agent. Use submit when done." \
  --json "Implement the change described in spec.md"
```

## Repo layout

- `src/main.ts` — the whole CLI (arg parsing, tool loading, agentic loop)
- `tools/` — example tool
- `~/bin/run-model` — shim: `tsx src/main.ts "$@"`
- Typecheck: `npx tsc --noEmit`
