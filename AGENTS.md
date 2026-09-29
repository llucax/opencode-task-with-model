# AGENTS.md

## Verifying that `task` applied a model and variant

- The recorded `task` input never shows `model` and `variant`, even when they applied: not to the calling agent reading back its own call, not in `opencode export`. Only the `task-model:` line in the task's output is evidence.
- Test with a route unlike what the subagent runs on without them: the agent's own `model`, or, for agents without one such as `general`, the primary agent's configured model and variant, not the variant the calling session currently runs at.
- Test from a session: tasks have no `task` tool of their own.
