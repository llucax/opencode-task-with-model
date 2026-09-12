# opencode-task-with-model

An [OpenCode](https://opencode.ai) plugin that lets agents run a task on a
model they name, instead of the one fixed in a subagent's agent file.

It registers one tool:

| Tool | Required arguments | Optional arguments | Result |
|---|---|---|---|
| `task_with_model` | `prompt`, `model` | `variant`, `agent`, `title`, `directory` | Runs the prompt in a child session on that model and returns its answer. |

## Why

The built-in `task` tool cannot choose a model. A subagent's model is pinned in
its agent file, so asking two providers the same question means maintaining two
near-identical subagents that differ only by that line. `model` is an argument
here, which collapses them into one call site that can pick against whatever
quota is left:

```
task_with_model(model = "anthropic/claude-opus-5", prompt = "Review this diff: ...")
task_with_model(model = "openai/gpt-5",            prompt = "Review this diff: ...")
```

Issued together those run concurrently, since the tool is an ordinary awaited
call. The child session is created with `parentID` set to the caller, so it
nests under the session that started it rather than becoming another top-level
session.

## Nested delegation

Nesting is forbidden. `task_with_model` rejects calls from child sessions, and
children it creates cannot call either `task` or `task_with_model`. A grandchild
that asks for permission or user input is not surfaced or navigable in the TUI,
which can leave every session in the delegation chain waiting indefinitely.

To reproduce the protected case manually, use `task_with_model` from a
top-level session with a prompt that tells the child to call `task_with_model`.
The child cannot make that tool call because it is disabled. To exercise the
explicit caller check, invoke `task_with_model` from any child session. It
returns the following without creating another session:

```text
task_with_model: nested delegation is not available; do the work inline in this session
```

## What it does about failure

Everything comes back as a single `task_with_model: <reason>` line rather than
as a thrown error. These usually run several at a time, and one model failing
should read as that model failing while the other answers survive, not as a
broken tool call.

Four outcomes are handled rather than assumed:

- A malformed `model` fails before any session is created, so a typo cannot
  leave an orphan child behind.
- A child that errors or is aborted still resolves, carrying the reason on its
  message. That is reported with any partial output kept.
- A child that finishes without saying anything reports that, naming the finish
  reason. An empty answer would otherwise read as success with no content.
- If the caller's own turn is cancelled, the child is aborted too, so an
  abandoned task stops instead of working on an answer nobody will read.

`model` is written `provider/model` and split at the **first** slash. Provider
IDs never contain a slash but model IDs can, so `openrouter/meta-llama/llama-3`
is the `openrouter` provider serving `meta-llama/llama-3`.

For model routing, the optional `variant` is OpenCode's per-prompt reasoning
effort control. More generally, a variant is a named bundle of provider options:
the same name can become `reasoningEffort` for one provider, Anthropic's
`effort` for another, Gemini's `thinkingLevel` for a third, or a computed token
budget for a budget-only model. This makes variants portable across providers
without exposing their different option formats.

Valid names come from the selected model's advertised or configured variants,
so the ladder differs by model and provider and can be extended in
`opencode.json`. A model with no advertised variants has no tunable effort.
OpenCode currently accepts unknown variant names but applies no variant options
for them, so callers should use a value exposed or configured for that model.

There is deliberately no `temperature` or `reasoning_effort` argument. The v1
`session.prompt` API has no fields for those individual knobs. Configure them as
model variants in `opencode.json`, then select the resulting variant by name.

## Installing

This repository is not published to npm. Install its dependencies and symlink
the plugin into OpenCode's plugin directory:

```sh
npm install
ln -sfn "$PWD/src/plugin.ts" ~/.config/opencode/plugins/task-with-model.ts
```

Restart OpenCode after installing or changing the plugin. OpenCode loads
plugins at startup.

## Development

```sh
npm install
npm run typecheck
npm test
```

The plugin file exports only its default plugin factory. OpenCode treats every
module export as a plugin factory, so another export would stop the plugin from
loading. The logic therefore lives in `src/run-task.ts`, which also describes
the client structurally as just the four calls it makes, so the tests can drive
it with a small fake instead of a running server.

## License

MIT, see [LICENSE](LICENSE).
