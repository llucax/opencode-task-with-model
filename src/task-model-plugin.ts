import type { Plugin } from "@opencode-ai/plugin"
import { createTaskModelHooks, type TaskModelClient } from "./task-model.ts"

/**
 * Opt-in plugin adding `model` and `variant` to the built-in `task` tool.
 *
 * Kept separate from `plugin.ts` so it is installed on its own. Like that
 * file, it must export only its plugin factory: the loader treats every export
 * as one and throws on the first that is not a function. The logic lives in
 * `task-model.ts`.
 *
 * Options, given through a `plugin` array entry: `toast` (default false)
 * shows a TUI toast when a task starts on an overridden route.
 */
export default (async ({ client }, options) =>
	createTaskModelHooks(
		// The v1 SDK's generated types lag behind the server: they miss the
		// variant on user messages, which the structural interface records.
		client as unknown as TaskModelClient,
		{
			warn: (message) => {
				void client.app
					.log({ body: { service: "task-model", level: "warn", message } })
					.catch(() => {})
			},
			toast:
				options?.toast === true
					? (message) => client.tui.showToast({ body: { message, variant: "info" } })
					: undefined,
		},
	)) satisfies Plugin
