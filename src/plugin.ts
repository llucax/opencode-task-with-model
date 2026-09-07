import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { runTaskWithModel } from "./run-task.ts"

/**
 * A file loaded as an opencode plugin must export only plugin factories: the
 * loader iterates every export and throws on the first one that is not a
 * function, taking every tool in the file down with it. Keep this file to
 * the single default export; put anything else in an imported module.
 */
export default (async ({ client }) => ({
	tool: {
		task_with_model: tool({
			description:
				"Run a prompt to completion in a child session on a model you name, and return its answer as text. Available only from a top-level session; child sessions must do their work inline. Use when the model matters: a second opinion from another provider, or the same task sent to several models at once. The built-in task tool cannot do this, because a subagent's model is fixed in its agent file. Calls issued together run concurrently.",
			args: {
				prompt: tool.schema.string().min(1).describe("The task for the child session to carry out."),
				model: tool.schema
					.string()
					.min(1)
					.describe("Model to run it on, as 'provider/model', for example anthropic/claude-opus-5."),
				agent: tool.schema
					.string()
					.optional()
					.describe("Agent for the child session. Defaults to the server's default agent."),
				title: tool.schema
					.string()
					.optional()
					.describe("Title for the child session. Defaults to a label naming the model."),
				directory: tool.schema
					.string()
					.optional()
					.describe("Project directory to run in. Defaults to the caller's directory."),
			},
			execute: (args, context) =>
				runTaskWithModel(client, {
					parentID: context.sessionID,
					prompt: args.prompt,
					model: args.model,
					agent: args.agent,
					title: args.title,
					directory: args.directory ?? context.directory,
					signal: context.abort,
				}),
		}),
	},
})) satisfies Plugin
