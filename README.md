# GROKING

A fast, terminal-first coding agent for Grok (`xAI`) with real file editing, patch workflows, live tool traces, and spawned worker agents.

```text
  GGG   RRRR    OOO   K  K  III  N   N   GGG
 G      R   R  O   O  K K    I   NN  N  G
 G  GG  RRRR   O   O  KK     I   N N N  G  GG
 G   G  R  R   O   O  K K    I   N  NN  G   G
  GGG   R   R   OOO   K  K  III  N   N   GGG
```

## Why GROKING

- Built for the real coding loop: inspect -> edit -> run checks -> refine
- Patch-style refactors with unified diffs (`apply_unified_patch`)
- Session continuity via `previous_response_id`
- Multi-agent workflow: planner + isolated spawned worker subagents
- Parallel worker execution with patch merge back into the main workspace
- Better CLI UX: spinner, compact tool logs, readable colored output, markdown-aware assistant rendering

## Features

- Interactive REPL + one-shot mode
- Local coding tools available to the model:
  - `list_files`, `search_files`, `read_file`, `write_file`, `replace_in_file`, `delete_file`
  - `apply_unified_patch`
  - `run_command`, `git_status`, `get_workspace_info`
- Slash commands:
  - `/help`, `/reset`, `/exit`
  - `/model`, `/model <name>`, `/models`
  - `/tools on|off`
- `/agents run <goal>`, `/agents spawn <task>`, `/agents status`, `/agents list`, `/agents result <id>`, `/agents log <id>`, `/agents wait`, `/agents clear`
- First-run key onboarding:
  - prompts for `XAI_API_KEY` if missing
  - stores key at `~/.groking/config.json`
- Session storage:
  - `~/.groking/sessions/*.json`

## Install

### Local (from source)

```bash
npm install
npm run build
node dist/cli.js
```

### Global (after publishing)

```bash
npm i -g groking-cli
# then run:
groking
```

## Quick Start

```bash
cd /path/to/repo-you-want-to-edit
groking --cwd .
```

Example prompts:

```text
Refactor the auth flow for clearer boundaries and run tests.
```

```text
Create a modern landing page with login CTA in top-right, then adjust to pink palette with subtle animations.
```

## CLI

```text
groking [prompt...] [options]

Options:
  -m, --model <model>             Grok model (default: grok-code-fast-1 or GROK_MODEL)
  --base-url <url>                API base URL (default: https://api.x.ai/v1)
  --session <name>                Session name; default is workspace hash
  --system <text>                 Extra system instruction
  --system-file <path>            Read extra system instruction from file
  --cwd <path>                    Workspace root for tools
  --no-tools                      Disable local tool access
  -p, --prompt <text>             One-shot prompt
  --reset                         Clear local saved session before run
  --allow-outside-workspace       Allow tools outside --cwd
  --timeout-ms <ms>               Default command timeout (default: 120000)
  --max-file-bytes <bytes>        Max readable file size (default: 2000000)
  --max-output-chars <chars>      Max stdout/stderr chars (default: 40000)
```

## Agentic Workflow (Planner -> Parallel Workers -> Merge)

Workers run in isolated workspace snapshots, execute in parallel, then return patches that are merged back into the main workspace in spawn order. The planner includes `scope` ownership and `depends_on` staging so setup can complete before dependent tasks run.

1. Run planner:

```text
/agents run build a production-ready login + onboarding flow with tests
```

2. Inspect workers:

```text
/agents list
```

3. Wait for all workers:

```text
/agents wait
```

4. Inspect worker + merge status:

```text
/agents status
/agents list
```

5. Inspect result from one worker:

```text
/agents result <id>
```

## Safety Model

- Workspace path boundaries enabled by default
- Patch validation before apply (`git apply --check --no-index`)
- Command output and file-read caps
- Tool loop guard for runaway tool calling

## Architecture

- `src/cli.ts` - startup, CLI args, one-shot/repl wiring
- `src/repl.ts` - slash commands and interactive loop
- `src/agent.ts` - xAI Responses orchestration + tool loop + planner support
- `src/subagents.ts` - spawned worker registry/execution manager
- `src/tools.ts` - local tool implementations
- `src/ui.ts` - spinner, colors, markdown-aware output formatting
- `src/session.ts` - persisted session linkage
- `src/auth.ts` - interactive API key setup
- `src/banner.ts` - GROKING startup banner

## Development

```bash
npm test
npx tsc --noEmit
npm run build
```

## Publishing

```bash
npm version patch
npm publish --access public
```

## License

MIT
