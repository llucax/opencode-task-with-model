/** A model identified the way the API wants it, split from "provider/model". */
export interface ModelRef {
	providerID: string
	modelID: string
}

/**
 * The slice of the OpenCode client this plugin uses.
 *
 * Declared structurally rather than imported from the SDK so the tests can
 * pass a small fake. The real client satisfies it, and keeping the surface
 * this narrow also documents exactly which calls the plugin depends on.
 */
export interface TaskClient {
	session: {
		get(input: {
			path: { id: string }
			query?: { directory?: string }
		}): Promise<{ data?: { id: string; parentID?: string }; error?: unknown }>
		create(input: {
			body: { parentID?: string; title?: string }
			query?: { directory?: string }
		}): Promise<{ data?: { id: string }; error?: unknown }>
		prompt(input: {
			path: { id: string }
			query?: { directory?: string }
			body: {
				agent?: string
				model?: ModelRef
				tools?: Record<string, boolean>
				parts: Array<{ type: "text"; text: string }>
			}
			signal?: AbortSignal
		}): Promise<{ data?: TaskAnswer; error?: unknown }>
		abort(input: { path: { id: string }; query?: { directory?: string } }): Promise<unknown>
	}
}

/** What `session.prompt` resolves to once the child's turn has ended. */
export interface TaskAnswer {
	info?: {
		error?: { name: string; data?: { message?: string } }
		finish?: string
	}
	parts?: Array<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean }>
}

export interface RunTaskInput {
	/** Session the child is created under, so it nests instead of floating. */
	parentID: string
	prompt: string
	model: string
	agent?: string
	title?: string
	directory?: string
	/** The caller's turn; aborting it must not leave the child running. */
	signal?: AbortSignal
}

/**
 * Split "provider/model" at the *first* slash.
 *
 * A provider ID never contains a slash but a model ID can, so the first slash
 * is the only correct split point: "openrouter/meta-llama/llama-3" is the
 * openrouter provider serving "meta-llama/llama-3", not something malformed.
 */
export function parseModelRef(input: string): ModelRef {
	const value = input.trim()
	const slash = value.indexOf("/")
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(
			`Model must be written as "provider/model" (for example anthropic/claude-opus-5), got ${JSON.stringify(input)}`,
		)
	}
	return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

/**
 * The child's answer as plain text.
 *
 * Synthetic parts come from the server rather than the model, and ignored
 * ones were dropped from the conversation, so neither belongs in something
 * the caller reads as the model's reply.
 */
export function joinTextParts(parts: TaskAnswer["parts"] = []): string {
	return parts
		.filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
		.map((part) => part.text ?? "")
		.filter((text) => text.trim() !== "")
		.join("\n")
		.trim()
}

/** One diagnosable line, whatever shape the failure arrived in. */
function fail(reason: unknown): string {
	const message =
		reason instanceof Error ? reason.message : typeof reason === "string" ? reason : JSON.stringify(reason)
	return `task_with_model: ${String(message).split("\n")[0]}`
}

/** Stop a child we are abandoning; failing to stop it is not worth reporting. */
async function abortQuietly(client: TaskClient, id: string, directory?: string): Promise<void> {
	await client.session.abort({ path: { id }, query: { directory } }).catch(() => {})
}

/**
 * Run one prompt to completion in a child session on the requested model and
 * return its text.
 *
 * Every failure comes back as a `task_with_model:` line rather than as a
 * thrown error. Several of these usually run at once against different
 * models, and one model failing should read as that model failing, not as the
 * tool breaking, while the other results survive.
 */
export async function runTaskWithModel(client: TaskClient, input: RunTaskInput): Promise<string> {
	try {
		const caller = await client.session.get({
			path: { id: input.parentID },
			query: { directory: input.directory },
		})
		if (caller.error) return fail(caller.error)
		if (!caller.data) return "task_with_model: looking up the calling session returned no session"
		if (caller.data.parentID) {
			return "task_with_model: nested delegation is not available; do the work inline in this session"
		}
	} catch (error) {
		return fail(error)
	}

	let model: ModelRef
	try {
		model = parseModelRef(input.model)
	} catch (error) {
		// Nothing has been created yet, so a bad model string costs nothing.
		return fail(error)
	}

	let sessionID: string
	try {
		const created = await client.session.create({
			body: { parentID: input.parentID, title: input.title ?? `Task on ${model.providerID}/${model.modelID}` },
			query: { directory: input.directory },
		})
		if (created.error) return fail(created.error)
		if (!created.data) return "task_with_model: creating the child session returned no session"
		sessionID = created.data.id
	} catch (error) {
		return fail(error)
	}

	let answer: TaskAnswer
	try {
		const result = await client.session.prompt({
			path: { id: sessionID },
			query: { directory: input.directory },
			body: {
				agent: input.agent,
				model,
				tools: { task: false, task_with_model: false },
				parts: [{ type: "text", text: input.prompt }],
			},
			signal: input.signal,
		})
		if (result.error) {
			await abortQuietly(client, sessionID, input.directory)
			return fail(result.error)
		}
		if (!result.data) {
			await abortQuietly(client, sessionID, input.directory)
			return `task_with_model: child session ${sessionID} returned no answer`
		}
		answer = result.data
	} catch (error) {
		// The caller's turn was cancelled or the request died with the child
		// still working. Left alone it would keep burning quota on an answer
		// nobody can read.
		await abortQuietly(client, sessionID, input.directory)
		return fail(error)
	}

	const text = joinTextParts(answer.parts)

	// A turn that failed or was aborted still resolves, carrying the reason on
	// the message. Whatever it produced first is worth keeping.
	const error = answer.info?.error
	if (error) {
		const detail = error.data?.message?.split("\n")[0]?.trim()
		const reason = detail ? `${error.name}: ${detail}` : error.name
		return text
			? `task_with_model: ${reason}\n\nPartial output before the failure:\n${text}`
			: `task_with_model: ${reason}`
	}

	// An empty string would read as a successful empty answer, the one outcome
	// the caller cannot act on.
	if (!text) {
		return `task_with_model: child session ${sessionID} finished without producing any text (finish reason: ${answer.info?.finish ?? "unknown"})`
	}

	return text
}
