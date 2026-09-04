# opencode-task-with-model

An [OpenCode](https://opencode.ai) plugin that lets agents run a task on a
model they name, instead of the one fixed in a subagent's agent file.

It registers one tool:

| Tool | Required arguments | Optional arguments | Result |
|---|---|---|---|
| `task_with_model` | `prompt`, `model` | `agent`, `title`, `directory` | Runs the prompt in a child session on that model and returns its answer. |

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

There is deliberately no `variant`, `temperature` or `reasoning_effort`
argument. Model choice is supported by the API; sampling and reasoning knobs are
not. A plugin's client is the SDK's v1 surface, where the `session.prompt` body
is exactly `messageID`, `model`, `agent`, `noReply`, `system`, `tools` and
`parts` — there is no field to put them in. They exist only as variants
configured in `opencode.json`.

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
the client structurally as just the three calls it makes, so the tests can drive
it with a small fake instead of a running server.

## License

MIT, see [LICENSE](LICENSE).
