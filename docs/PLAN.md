# GrokCode CLI Plan

## Goal
Build an end-to-end terminal coding assistant for Grok that can inspect code, edit files, run commands, and keep multi-turn context.

## Scope (MVP)

1. API integration
- Use xAI OpenAI-compatible Responses endpoint (`https://api.x.ai/v1`).
- Support configurable model (default `grok-code-fast-1`).

2. Agent loop
- Prompt -> response -> tool calls -> tool outputs -> follow-up response.
- Multi-step tool loop with loop guard.

3. Local coding tools
- File listing/search/read/write/replace/delete.
- Unified patch application tool with validation/dry-run.
- Shell command execution with timeout and output caps.
- Git status helper.

4. Session/context
- Persist `previous_response_id` per workspace/session.
- Reset capability.

5. CLI UX
- REPL and one-shot mode.
- Slash commands for model/tools/reset/exit.

6. Docs
- Setup, usage, architecture, and extension path.

## Delivered
- All MVP scope implemented in this repository.

## Follow-up Enhancements
- Streaming token output.
- Tool-approval UI.
- Structured edit tool (`apply_patch`) and AST codemods.
- Better diff/review UX.
