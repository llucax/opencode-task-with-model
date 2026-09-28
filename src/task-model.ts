import { parseModelRef, type ModelRef } from "./run-task.ts"

/**
 * Model choice for OpenCode's built-in `task` tool, added through plugin hooks
 * instead of a replacement tool.
 *
 * The built-in keeps doing all the work: permissions, the subagent depth
 * limit, the child session's ruleset, `task_id` resumption, background mode,
 * and the live sub-task view in the TUI. These hooks only add two optional
 * arguments and swap the model on the child's first message:
 *
 * 1. `tool.definition` adds `model` and `variant` to the schema the model sees.
 * 2. `tool.execute.before` validates them and remembers them by call ID.
 * 3. `chat.message` fires when the built-in prompts the child. The built-in
 *    has already written the child's session ID into its tool part's
 *    metadata by then, which is how the child is matched to its call, even
 *    when several calls with the same prompt run at once.
 * 4. `tool.execute.after` checks that the child really ran on the requested
 *    model, says so in the output if it did not, and puts the route it ran
 *    on before the result.
 *
 * Steps 1 and 3 rely on behavior the plugin API does not document, which is
 * why step 4 exists: if an OpenCode upgrade breaks it, the caller is told
 * instead of silently getting the default model.
 */

export const TASK_TOOL_ID = "task"

/** Pending entries older than this are dropped; the call failed or never got a child. */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000

const MODEL_DESCRIPTION =
	"Model to run the subagent on, as 'provider/model', overriding the agent's own model. Omit to keep the default."
const VARIANT_DESCRIPTION =
	"Model variant, such as an effort or thinking level. Valid values depend on the model and the variants configured in opencode.json."
const TOOL_NOTE =
	"Pass `model` (as provider/model) and optionally `variant` only when the subagent must run on a specific model; otherwise leave them out. Before calling `task`, write one line per task with its agent, model and variant (the agent's default when omitted), since the sub-task view doesn't show them."

const FALLBACK_HINT =
	"The model override for the task tool may have stopped working with this OpenCode version; use task_with_model to choose a model."

/** What a caller asked for. At least one of the two is set. */
export interface Override {
	model?: ModelRef
	variant?: string
}

/** The model fields of a user message as the server stores them. */
export interface MessageModel {
	providerID: string
	modelID: string
	variant?: string
}

/**
 * The slice of the OpenCode client the hooks use, declared structurally so the
 * tests can pass a small fake, as in `run-task.ts`.
 */
export interface TaskModelClient {
	session: {
		get(input: { path: { id: string } }): Promise<{ data?: { id: string; parentID?: string }; error?: unknown }>
		messages(input: {
			path: { id: string }
			query?: { limit?: number }
		}): Promise<{ data?: SessionMessage[]; error?: unknown }>
	}
	config: {
		providers(): Promise<{
			data?: { providers: Array<{ id: string; models: Record<string, unknown> }> }
			error?: unknown
		}>
	}
}

/** A message with its parts, reduced to the fields read here. */
export interface SessionMessage {
	info: {
		role: string
		time?: { created?: number }
		// Assistant messages carry the model flat, user messages nested.
		providerID?: string
		modelID?: string
		variant?: string
		model?: MessageModel
	}
	parts: Array<{
		type: string
		tool?: string
		callID?: string
		state?: { metadata?: Record<string, unknown> }
	}>
}

/**
 * Add `model` and `variant` to the task tool's definition.
 *
 * Returns false and changes nothing when the definition has no JSON Schema to
 * extend. The built-in only omits it when OpenCode's experimental background
 * subagents are on, where its parameters are an Effect schema this plugin
 * cannot extend.
 *
 * The schema is cloned rather than edited in place: the hook receives the
 * registry's own object, and editing it would change the stored definition.
 */
export function extendTaskDefinition(output: { description: string; jsonSchema?: unknown }): boolean {
	const schema = output.jsonSchema
	if (!isRecord(schema) || !isRecord(schema.properties)) return false
	const extended = structuredClone(schema) as Record<string, unknown> & { properties: Record<string, unknown> }
	extended.properties.model = { type: "string", description: MODEL_DESCRIPTION }
	extended.properties.variant = { type: "string", description: VARIANT_DESCRIPTION }
	output.jsonSchema = extended
	if (!output.description.includes(TOOL_NOTE)) output.description = `${output.description}\n\n${TOOL_NOTE}`
	return true
}

/**
 * Read and remove `model` and `variant` from a task call's arguments.
 *
 * Removing them keeps the built-in from ever seeing arguments it does not
 * know. It ignores unknown keys today, but that is not a promise.
 *
 * Throws on a malformed value, which fails the call before any child session
 * exists. Returns undefined when neither argument was given.
 */
export function takeOverrideArgs(args: unknown): Override | undefined {
	if (!isRecord(args)) return undefined
	const { model, variant } = args
	delete args.model
	delete args.variant

	const override: Override = {}
	if (model !== undefined && model !== null) {
		if (typeof model !== "string") throw new Error(`task: model must be a string, got ${JSON.stringify(model)}`)
		override.model = parseModelRef(model)
	}
	if (variant !== undefined && variant !== null) {
		if (typeof variant !== "string") throw new Error(`task: variant must be a string, got ${JSON.stringify(variant)}`)
		if (variant.trim() === "") throw new Error("task: variant must not be blank")
		override.variant = variant.trim()
	}
	return override.model || override.variant ? override : undefined
}

/**
 * Fail unless the model is configured, so a typo costs a failed call rather
 * than a child session that errors on its first request.
 */
export async function ensureModelExists(client: TaskModelClient, model: ModelRef): Promise<void> {
	const result = await client.config.providers()
	if (result.error || !result.data) return // Can't tell; let the server decide.
	const provider = result.data.providers.find((item) => item.id === model.providerID)
	if (!provider) {
		const known = result.data.providers.map((item) => item.id).sort()
		throw new Error(`task: unknown provider "${model.providerID}"; configured providers: ${known.join(", ")}`)
	}
	if (!(model.modelID in provider.models)) {
		throw new Error(`task: provider "${model.providerID}" has no model "${model.modelID}"`)
	}
}

/** Overrides waiting for their child session, by the tool call's ID. */
export class PendingOverrides {
	private readonly entries = new Map<
		string,
		Override & { createdAt: number; applied: boolean; finished: boolean }
	>()

	private readonly now: () => number

	constructor(now: () => number = Date.now) {
		this.now = now
	}

	get size(): number {
		return this.entries.size
	}

	has(callID: string): boolean {
		return this.entries.has(callID)
	}

	add(callID: string, override: Override): void {
		this.prune()
		this.entries.set(callID, { ...override, createdAt: this.now(), applied: false, finished: false })
	}

	/** The override for the child's first message; later ones get nothing. */
	claim(callID: string): Override | undefined {
		const entry = this.entries.get(callID)
		if (!entry || entry.applied) return undefined
		entry.applied = true
		if (entry.finished) this.entries.delete(callID)
		return { model: entry.model, variant: entry.variant }
	}

	/**
	 * The call returned. The entry goes away, unless it was never applied and
	 * `stillRunning` says the child may not have been prompted yet (background
	 * mode), in which case `claim` removes it later.
	 */
	finish(callID: string, stillRunning: boolean): (Override & { applied: boolean }) | undefined {
		const entry = this.entries.get(callID)
		if (!entry) return undefined
		if (!entry.applied && stillRunning) entry.finished = true
		else this.entries.delete(callID)
		return { model: entry.model, variant: entry.variant, applied: entry.applied }
	}

	/**
	 * `tool.execute.after` never runs for a failed call, so without this every
	 * failure would leave its entry behind for the life of the server.
	 */
	private prune(): void {
		const cutoff = this.now() - PENDING_MAX_AGE_MS
		for (const [callID, entry] of this.entries) if (entry.createdAt < cutoff) this.entries.delete(callID)
	}
}

/**
 * The call ID of the pending `task` call that created this child session.
 *
 * The part's status is not checked: in background mode the call can have
 * returned before the child is prompted.
 */
export function findTaskCall(
	messages: SessionMessage[],
	childSessionID: string,
	isPending: (callID: string) => boolean,
): string | undefined {
	for (const message of messages.toReversed()) {
		for (const part of message.parts) {
			if (part.type !== "tool" || part.tool !== TASK_TOOL_ID || !part.callID) continue
			if (part.state?.metadata?.sessionId !== childSessionID) continue
			if (isPending(part.callID)) return part.callID
		}
	}
	return undefined
}

/** Point a user message at the requested model. A variant alone keeps the model. */
export function applyOverride(model: MessageModel, override: Override): MessageModel {
	const next: MessageModel = override.model
		? { providerID: override.model.providerID, modelID: override.model.modelID }
		: { providerID: model.providerID, modelID: model.modelID }
	// With a new model the old variant may not exist for it; drop it unless asked.
	const variant = override.variant ?? (override.model ? undefined : model.variant)
	if (variant !== undefined) next.variant = variant
	return next
}

/** The model a message says it ran on, whichever role it has. */
function messageModel(info: SessionMessage["info"]): MessageModel | undefined {
	if (info.providerID && info.modelID) {
		return { providerID: info.providerID, modelID: info.modelID, variant: info.variant }
	}
	if (info.model?.providerID && info.model.modelID) return info.model
	return undefined
}

/** The model the child's newest message ran on, or undefined when it has none yet. */
export function latestModel(childMessages: SessionMessage[]): MessageModel | undefined {
	return childMessages
		.map((message, index) => ({ model: messageModel(message.info), created: message.info.time?.created ?? 0, index }))
		.filter((item) => item.model)
		.sort((a, b) => a.created - b.created || a.index - b.index)
		.at(-1)?.model
}

/**
 * The line put before a task's result naming the route its child ran on.
 *
 * The plugin removes `model` and `variant` from the call's arguments, so the
 * stored call shows neither; without this line neither the caller nor anyone
 * reading the session later could tell which route the child used.
 */
export function describeRoute(model: MessageModel): string {
	const variant = model.variant ? `variant ${model.variant}` : "no variant"
	return `task-model: ran on ${model.providerID}/${model.modelID}, ${variant}`
}

/**
 * A warning when the child's newest message is not on the requested model,
 * or undefined when it matches or there is nothing to check yet.
 */
export function describeMismatch(override: Override, childMessages: SessionMessage[]): string | undefined {
	const latest = latestModel(childMessages)
	if (!latest) return undefined

	const problems: string[] = []
	if (override.model) {
		const wanted = `${override.model.providerID}/${override.model.modelID}`
		const got = `${latest.providerID}/${latest.modelID}`
		if (wanted !== got) problems.push(`requested model ${wanted} but the subagent ran on ${got}`)
	}
	if (override.variant && latest.variant !== override.variant) {
		problems.push(`requested variant ${override.variant} but the subagent ran with ${latest.variant ?? "none"}`)
	}
	if (!problems.length) return undefined
	return `task: ${problems.join("; ")}. ${FALLBACK_HINT}`
}

type HookOutput<T> = T & Record<string, unknown>

/** The hooks, built over a client so the tests can drive them with a fake. */
export function createTaskModelHooks(client: TaskModelClient, options: { warn?: (message: string) => void } = {}) {
	const pending = new PendingOverrides()
	const warn = options.warn ?? (() => {})
	let warnedNoSchema = false

	return {
		"tool.definition": async (input: { toolID: string }, output: HookOutput<{ description: string }>) => {
			if (input.toolID !== TASK_TOOL_ID) return
			if (extendTaskDefinition(output) || warnedNoSchema) return
			warnedNoSchema = true
			warn("task tool has no JSON Schema to extend (experimental background subagents on?); model and variant are unavailable")
		},

		"tool.execute.before": async (input: { tool: string; callID: string }, output: { args: unknown }) => {
			if (input.tool !== TASK_TOOL_ID) return
			const override = takeOverrideArgs(output.args)
			if (!override) return
			if (override.model) await ensureModelExists(client, override.model)
			pending.add(input.callID, override)
		},

		"chat.message": async (input: { sessionID: string }, output: { message: { model: MessageModel } }) => {
			if (pending.size === 0) return
			const session = await client.session.get({ path: { id: input.sessionID } })
			const parentID = session.data?.parentID
			if (!parentID) return
			// The calling message is the newest one or close to it; only look
			// through the whole session if it isn't there.
			let callID: string | undefined
			for (const limit of [10, undefined]) {
				const messages = await client.session.messages({ path: { id: parentID }, query: limit ? { limit } : undefined })
				callID = findTaskCall(messages.data ?? [], input.sessionID, (id) => pending.has(id))
				if (callID) break
			}
			const override = callID && pending.claim(callID)
			if (!override) return
			output.message.model = applyOverride(output.message.model, override)
		},

		"tool.execute.after": async (
			input: { tool: string; callID: string },
			output: { output: string; metadata: Record<string, unknown> | undefined },
		) => {
			if (input.tool !== TASK_TOOL_ID) return
			const background = output.metadata?.background === true
			const override = pending.finish(input.callID, background)
			if (!override) return
			// A background child may not have been prompted yet; nothing to check.
			if (background && !override.applied) return
			const childID = output.metadata?.sessionId
			if (typeof childID !== "string") return
			const messages = (await client.session.messages({ path: { id: childID }, query: { limit: 5 } })).data ?? []
			// The built-in reports the model it meant to use, which is the
			// default; report the one the child actually ran on instead.
			const ran = latestModel(messages)
			if (ran && output.metadata) {
				output.metadata = { ...output.metadata, model: { providerID: ran.providerID, modelID: ran.modelID } }
			}
			const mismatch =
				describeMismatch(override, messages) ??
				// Never matched to its child: the built-in stopped publishing the
				// child's sessionId before prompting it, or chat.message stopped
				// firing for it. Either way the default model ran.
				(override.applied ? undefined : `task: the model override was never applied to the subagent. ${FALLBACK_HINT}`)
			// The warning stays first; the route follows it, verified rather
			// than as requested.
			const lines = [mismatch, ran && describeRoute(ran)].filter((line) => line)
			if (lines.length) output.output = `${lines.join("\n")}\n\n${output.output}`
		},
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
