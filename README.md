<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/powered%20by-xAI%20Grok-blueviolet" alt="Powered by xAI Grok" />
  <img src="https://img.shields.io/npm/v/groking-cli?color=orange" alt="npm version" />
</p>

<h1 align="center">GROKING</h1>

<p align="center">
  <strong>A terminal-first coding agent powered by <a href="https://x.ai">xAI Grok</a></strong><br/>
  Real file editing &bull; Patch workflows &bull; Parallel worker agents &bull; Session continuity
</p>

<br/>

```
  ██████  ██████   █████   ██  ██  ██  ██   ██   ██████
  ██      ██   ██ ██   ██  ██ ██   ██  ███  ██  ██
  ██  ███ ██████  ██   ██  ████    ██  ██ █ ██  ██  ███
  ██   ██ ██  ██  ██   ██  ██ ██   ██  ██  ███  ██   ██
   ██████ ██   ██  █████   ██  ██  ██  ██   ██   ██████
```

<br/>

## Why Groking?

Most AI coding tools run in the cloud or inside an IDE. **Groking** runs where you already work — your terminal. It connects directly to xAI's Responses API, gives the model full access to your local filesystem and shell, and supports a real coding loop:

**Inspect → Edit → Run checks → Refine**

- **Patch-style refactoring** — multi-file changes via unified diffs (`apply_unified_patch`)
- **Session continuity** — pick up where you left off across terminal sessions
- **Multi-agent parallelism** — a planner breaks complex goals into isolated worker agents that run in parallel, then merges patches back
- **Zero config** — just provide your xAI API key and start coding

---

## Quick Start

```bash
# Install globally (recommended)
npm i -g groking-cli

# Run in your project
groking --cwd .
```

On first run, Groking will prompt for your `XAI_API_KEY` and save it to `~/.groking/config.json` for future sessions.

```bash
# Or set the key via environment
export XAI_API_KEY="xai-..."
groking --cwd .
```

### Run from source (development)

```bash
git clone https://github.com/ranausmanai/groking.git
cd groking
npm install
npm run build
node dist/cli.js --cwd .
```

---

## Usage

### Interactive mode (REPL)

```bash
groking --cwd /path/to/your/project
```

You'll get an interactive prompt where you can ask the agent to read, edit, refactor, debug, and run commands in your project.

### One-shot mode

```bash
groking "fix the type error in src/utils.ts and run the tests"
```

```bash
groking -p "add input validation to the signup handler"
```

### Example prompts

```
Refactor the auth flow into separate middleware layers and run tests.
```
```
Find the bug causing the 500 on /api/users and fix it.
```
```
Create a React component for the settings page with proper TypeScript types.
```

---

## CLI Options

```
groking [prompt...] [options]
```

| Option | Default | Description |
|---|---|---|
| `-m, --model <model>` | `grok-code-fast-1` | Grok model to use |
| `--planner-model <model>` | auto-select | Dedicated model for `/agents run` planning |
| `--base-url <url>` | `https://api.x.ai/v1` | xAI API base URL |
| `--session <name>` | workspace hash | Named session for conversation continuity |
| `--system <text>` | — | Additional system prompt |
| `--system-file <path>` | — | Load additional system prompt from file |
| `--cwd <path>` | current dir | Workspace root for all tool operations |
| `--no-tools` | — | Disable local tool access |
| `-p, --prompt <text>` | — | One-shot prompt (alternative to positional args) |
| `--reset` | `false` | Clear saved session state before starting |
| `--allow-outside-workspace` | `false` | Allow file/shell operations outside workspace |
| `--timeout-ms <ms>` | `120000` | Shell command timeout |
| `--max-file-bytes <bytes>` | `2000000` | Max readable file size |
| `--max-output-chars <chars>` | `40000` | Max captured stdout/stderr |

---

## Slash Commands

Once in the interactive REPL, use these commands:

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/exit`, `/quit` | Exit the REPL |
| `/reset` | Clear conversation context and start fresh |
| `/model` | Show the current model |
| `/model <name>` | Switch to a different model |
| `/planner` | Show current planner model |
| `/planner <name>` | Switch planner model used by `/agents run` |
| `/planner auto` | Reset planner selection to auto-pick mode |
| `/models` | List all available models from the API |
| `/tools on\|off` | Enable or disable local tool access |

### Subagent commands

| Command | Description |
|---|---|
| `/agents run <goal>` | Planner decomposes goal into parallel worker tasks |
| `/agents spawn <task>` | Manually spawn a single worker agent |
| `/agents status` | Show live progress (queued, running, completed, merge status) |
| `/agents list` | List all workers with status, duration, scope, dependencies |
| `/agents result <id>` | Show full output from a specific worker |
| `/agents log <id>` | Show tool execution log for a worker |
| `/agents wait` | Block until all workers complete |
| `/agents clear` | Remove completed/failed workers from the list |

---

## Tools

When tool access is enabled (the default), the model can use these local tools:

| Tool | Description |
|---|---|
| `list_files` | List files and directories (supports recursive, hidden, max entries) |
| `search_files` | Regex search across files using ripgrep (with glob filtering) |
| `read_file` | Read file content with optional line range |
| `write_file` | Write or create files (auto-creates directories) |
| `replace_in_file` | Find and replace exact strings in a file |
| `delete_file` | Delete a file |
| `apply_unified_patch` | Apply unified diff patches for multi-file refactoring |
| `run_command` | Execute shell commands in the workspace |
| `git_status` | Get current git branch and status |
| `get_workspace_info` | Show workspace path and configuration |

All tools respect the workspace boundary by default. Use `--allow-outside-workspace` to relax this.

---

## Multi-Agent Workflow

Groking's most powerful feature is its **planner → parallel workers → merge** pipeline. This lets you tackle complex, multi-file tasks by splitting them across isolated worker agents that execute in parallel.

### How it works

1. **Plan** — A dedicated planner model analyzes your goal and decomposes it into 2–6 scoped tasks with dependency ordering
2. **Spawn** — Each task runs as an isolated worker agent with its own workspace snapshot
3. **Execute** — Up to 4 workers run in parallel (with scope-aware contention prevention)
4. **Merge** — Completed workers produce unified diff patches that are merged back in spawn order

### When to use `/agents run` vs normal prompt

Use the right mode for the job:

- Use **normal prompt** for single-file or creative output (for example: one HTML demo, one animation page, one script).
- Use **`/agents run`** for larger engineering goals with multiple moving parts (for example: refactor + tests + migration + verification).

Why: `/agents run` optimizes for decomposition, scope safety, dependency ordering, and merge reliability. For simple creative tasks, direct mode is often faster and more coherent.

### Example

```
groking> /agents run build a login page with form validation, add API route for auth, and write tests for both

Planning... broke goal into 4 tasks:
  1. setup       → Create shared types and constants
  2. login-ui    → Build login page component (depends on: setup)
  3. auth-api    → Add /api/auth route (depends on: setup)
  4. tests       → Write tests for login + auth (depends on: login-ui, auth-api)

groking> /agents status
  Workers: 1 running, 1 queued, 2 waiting on dependencies
  Merges:  0 applied, 0 conflicts

groking> /agents wait
  All 4 workers completed. 3 patches applied, 0 conflicts.
```

### Worker isolation

- Each worker gets a **temporary snapshot** of your workspace in `/tmp/groking-worker-*`
- Workers cannot interfere with each other or your live workspace
- After completion, a `git diff --no-index` generates a clean patch
- Patches skip build artifacts (`node_modules`, `dist`, `.next`, `coverage`, etc.)
- Merge conflicts are detected and reported — no silent overwrites

### Dependency resolution

Workers can declare dependencies on other workers via the `depends_on` field. A worker won't start until its dependencies have completed and merged successfully. If a dependency fails or has a merge conflict, dependent workers are automatically blocked.

### Live output and logs

- Live `/agents` output is intentionally summarized to reduce console spam.
- You will see major lifecycle events (queued, started, done, merged), status heartbeat, and command starts/timeouts.
- For full per-tool detail, use `/agents log <id>`.
- To force full tool streaming in console, start with `GROKING_VERBOSE_TOOL_STREAM=1`.

---

## Authentication

Groking looks for your xAI API key in this order:

1. `XAI_API_KEY` environment variable
2. `~/.groking/config.json` (`xai_api_key` field)
3. Interactive prompt (input is hidden) — saves to config for next time

```bash
# Option 1: environment variable
export XAI_API_KEY="xai-..."

# Option 2: .env file in your project
echo 'XAI_API_KEY=xai-...' >> .env

# Option 3: just run groking and paste when prompted
```

---

## Session Management

Groking persists conversation context across sessions so you can close your terminal and pick up where you left off.

- **Storage**: `~/.groking/sessions/<name>.json`
- **Default name**: SHA-1 hash of your workspace path
- **Custom name**: `groking --session my-project`
- **Reset**: `groking --reset` or `/reset` in the REPL

Sessions store the `previousResponseId` from xAI's Responses API, which maintains full conversation history server-side without re-sending messages.

---

## Safety

Groking includes several guardrails to prevent accidents:

- **Workspace boundaries** — tools are restricted to your `--cwd` by default
- **Patch validation** — patches are verified with `git apply --check` before applying
- **Output caps** — file reads and command output are capped to prevent context overflow
- **Tool loop guard** — max 24 tool rounds per turn to prevent runaway loops
- **Patch size limits** — rejects patches over 900KB (likely build artifacts)
- **Excluded directories** — patches automatically skip `node_modules`, `dist`, `.next`, `.nuxt`, `coverage`, `.cache`, `.turbo`, `.vite`

---

## Architecture

```
src/
├── cli.ts          # Entry point, CLI argument parsing, one-shot/REPL wiring
├── repl.ts         # Interactive loop, slash commands, subagent UI
├── agent.ts        # xAI Responses API orchestration, tool loop, planner
├── subagents.ts    # Worker registry, isolation, parallel execution, patch merging
├── tools.ts        # Local tool implementations (file ops, shell, git)
├── prompts.ts      # System prompt for the coding agent
├── ui.ts           # Spinner, colors, markdown rendering
├── session.ts      # Session persistence
├── auth.ts         # API key resolution and storage
└── banner.ts       # Startup banner
```

---

## Development

```bash
# Type-check
npx tsc --noEmit

# Run tests
npm test

# Build
npm run build

# Dev mode (no build step)
npm run dev
```

## Publishing

```bash
npm version patch
npm publish --access public
```

---

## Requirements

- **Node.js** >= 20
- **ripgrep** (`rg`) — used by `search_files` tool (install via `brew install ripgrep` or your package manager)
- An **xAI API key** — get one at [console.x.ai](https://console.x.ai)

---

## License

MIT
