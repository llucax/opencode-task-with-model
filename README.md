# opencode-task-with-model

An [OpenCode](https://opencode.ai) plugin that lets agents run a task on a
model they name, instead of the one fixed in a subagent's agent file.

It registers one tool:

| Tool | Required arguments | Optional arguments | Result |
|---|---|---|---|
| `task_with_model` | `prompt`, `model` | `variant`, `agent`, `title`, `directory` | Runs the prompt in a child session on that model and returns its answer. |

A second, opt-in plugin file adds the same choice to OpenCode's built-in
`task` tool instead, as optional `model` and `variant` arguments; see [Model
choice on the built-in task tool](#model-choice-on-the-built-in-task-tool-opt-in).

## Why

Out of the box, the built-in `task` tool cannot choose a model. A subagent's
model is pinned in its agent file, so asking two providers the same question
means maintaining two near-identical subagents that differ only by that line.
`model` is an argument here, which collapses them into one call site that can
pick against whatever quota is left:

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

## Model choice on the built-in task tool (opt-in)

`src/task-model-plugin.ts` adds two optional arguments to the built-in `task`
tool: `model`, written `provider/model` as above, and `variant`. The subagent
runs on that model instead of its own, even when its agent file pins one:

```
task(subagent_type = "explore", model = "anthropic/claude-opus-5", variant = "high", prompt = "...")
```

It works through plugin hooks on the built-in tool rather than by replacing it,
so everything the built-in does stays as it is: the live sub-task view in the
TUI, `task` permissions, `subagent_depth`, `task_id` resumption, `@agent`
mentions and commands with `subtask: true`. Calls without the new arguments
behave exactly as before.

A malformed `model`, or one no configured provider has, fails the call before
any child session is created. A `model` without `variant` drops the caller's
variant, since it may not exist for the new model; a `variant` without `model`
keeps the subagent's model.

### How it works, and what it relies on

When the model calls `task` with an override, the plugin removes `model` and
`variant` from the arguments and remembers them by the call's ID. The built-in
creates the child session and writes the child's ID into its tool call's
metadata before prompting it, and the plugin's `chat.message` hook uses that ID
to find the call and switch the child's first message to the requested model.
The match is by call, so parallel calls with identical prompts each get their
own model.

Three of the behaviors this needs are not part of OpenCode's documented plugin
API. They were checked against OpenCode 1.18.32:

- The `tool.definition` hook receives the tool's JSON Schema as `jsonSchema`,
  and a changed one is what the model sees.
- A change to the user message's model in `chat.message` is saved and used for
  that turn.
- The built-in publishes the child's session ID before prompting it.

When a call finishes, the plugin reads the model the child actually ran on. If
it isn't the requested one, or the override never reached the child, the tool
output starts with a line saying so:

```text
task: requested model anthropic/claude-opus-5 but the subagent ran on openai/gpt-6. The model override for the task tool may have stopped working with this OpenCode version; use task_with_model to choose a model.
```

`task_with_model` doesn't depend on any of this, which is why it stays: it is
the fallback when an OpenCode upgrade breaks these hooks.

### Known limitations

- The child session's own record keeps the subagent's default model, while its
  messages run on the requested one. A follow-up typed into that subagent
  without choosing a model runs on the default
  ([#2](https://github.com/llucax/opencode-task-with-model/issues/2)).
- With OpenCode's experimental background subagents enabled, the built-in's
  definition has no JSON Schema to extend, so the arguments are not offered;
  the plugin logs a warning once.

## Installing

This repository is not published to npm. Install its dependencies and symlink
the plugin into OpenCode's plugin directory:

```sh
npm install
ln -sfn "$PWD/src/plugin.ts" ~/.config/opencode/plugins/task-with-model.ts
```

To also get `model` and `variant` on the built-in `task` tool, link the second
plugin file too. It is independent of the first; either can be installed alone:

```sh
ln -sfn "$PWD/src/task-model-plugin.ts" ~/.config/opencode/plugins/task-model.ts
```

Restart OpenCode after installing or changing the plugin. OpenCode loads
plugins at startup.

## Development

```sh
npm install
npm run typecheck
npm test
```

`scripts/e2e.sh` checks the `task` overrides against a real `opencode serve`,
answered by [openai-fake-provider](https://github.com/llucax/openai-fake-provider)
so no request reaches a real model. It needs `opencode`, `curl`, `jq` and
`python3`, plus the fake provider as an `openai-fake-provider` command or
through `OPENAI_FAKE_PROVIDER`, the path to its `openai_fake_provider.py`.
Everything OpenCode stores goes to a temporary directory, removed at the end
unless `KEEP=1`. Run it after upgrading OpenCode:

```sh
OPENAI_FAKE_PROVIDER=../openai-fake-provider/openai_fake_provider.py scripts/e2e.sh
```

CI runs it in OpenCode's official container image, built from
`.github/e2e/Dockerfile`, both on the version pinned there and on the latest
release: on every pull request and push, and weekly. A failure on the latest
release only fails the weekly run, which is what sends a notification.
Dependabot bumps the pinned image; bump the "checked against" version above
along with it.

The plugin files export only their default plugin factory. OpenCode treats
every module export as a plugin factory, so another export would stop the
plugin from loading. The logic therefore lives in `src/run-task.ts` and
`src/task-model.ts`, which also describe the client structurally as just the
calls they make, so the tests can drive them with a small fake instead of a
running server.

## License

MIT, see [LICENSE](LICENSE).
