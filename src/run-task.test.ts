import assert from "node:assert/strict"
import test from "node:test"
import { joinTextParts, parseModelRef, runTaskWithModel, type TaskClient } from "./run-task.ts"

type Session = TaskClient["session"]

/**
 * A client that succeeds at everything, with any call replaceable. `aborted`
 * records the sessions the code decided to stop, which is how the abandoned
 * child cases are checked.
 */
function clientWith(overrides: Partial<Session> = {}): { client: TaskClient; aborted: string[] } {
	const aborted: string[] = []
	const client: TaskClient = {
		session: {
			get: async (input) => ({ data: { id: input.path.id } }),
			create: async () => ({ data: { id: "ses_child" } }),
			prompt: async () => ({ data: { parts: [{ type: "text", text: "the answer" }] } }),
			abort: async (input) => {
				aborted.push(input.path.id)
				return {}
			},
			...overrides,
		},
	}
	return { client, aborted }
}

const base = { parentID: "ses_parent", prompt: "do the thing", model: "anthropic/claude-opus-5" }

test("a model string is split at the first slash", () => {
	assert.deepEqual(parseModelRef("anthropic/claude-opus-5"), {
		providerID: "anthropic",
		modelID: "claude-opus-5",
	})
})

test("a model ID may itself contain slashes", () => {
	// Providers never have a slash in their ID but models do, so splitting
	// anywhere but the first slash would mangle this into a bad request.
	assert.deepEqual(parseModelRef("openrouter/meta-llama/llama-3"), {
		providerID: "openrouter",
		modelID: "meta-llama/llama-3",
	})
})

test("surrounding whitespace does not change a model string", () => {
	assert.deepEqual(parseModelRef("  anthropic/claude-opus-5\n"), {
		providerID: "anthropic",
		modelID: "claude-opus-5",
	})
})

test("a model string that is not provider/model is rejected", () => {
	for (const bad of ["", "   ", "claude-opus-5", "/claude-opus-5", "anthropic/", "/"]) {
		assert.throws(
			() => parseModelRef(bad),
			/provider\/model/,
			`expected ${JSON.stringify(bad)} to be rejected`,
		)
	}
})

test("a finished task returns the child's text", async () => {
	const { client } = clientWith()
	assert.equal(await runTaskWithModel(client, base), "the answer")
})

test("the child is created under the caller, on the requested model", async () => {
	// The whole point of the tool is that the model reaches the prompt call,
	// and parentID is what keeps the child nested instead of top-level.
	let created: unknown
	let prompted: unknown
	const { client } = clientWith({
		create: async (input) => {
			created = input
			return { data: { id: "ses_child" } }
		},
		prompt: async (input) => {
			prompted = input
			return { data: { parts: [{ type: "text", text: "hi" }] } }
		},
	})

	await runTaskWithModel(client, { ...base, agent: "plan", title: "Review", directory: "/work" })

	assert.deepEqual(created, {
		body: { parentID: "ses_parent", title: "Review" },
		query: { directory: "/work" },
	})
	assert.deepEqual(prompted, {
		path: { id: "ses_child" },
		query: { directory: "/work" },
		body: {
			agent: "plan",
			model: { providerID: "anthropic", modelID: "claude-opus-5" },
			tools: { task: false, task_with_model: false },
			parts: [{ type: "text", text: "do the thing" }],
		},
		signal: undefined,
	})
	assert.equal(Object.hasOwn((prompted as { body: object }).body, "variant"), false)
})

test("a variant reaches the requested model's prompt", async () => {
	let prompted: Parameters<Session["prompt"]>[0] | undefined
	const { client } = clientWith({
		prompt: async (input) => {
			prompted = input
			return { data: { parts: [{ type: "text", text: "hi" }] } }
		},
	})

	await runTaskWithModel(client, {
		...base,
		model: "openrouter/meta-llama/llama-3",
		variant: "high",
	})

	assert.deepEqual(prompted?.body.model, {
		providerID: "openrouter",
		modelID: "meta-llama/llama-3",
	})
	assert.equal(prompted?.body.variant, "high")
})

test("a blank variant fails before any session is created", async () => {
	let getCalls = 0
	let createCalls = 0
	const { client } = clientWith({
		get: async (input) => {
			getCalls++
			return { data: { id: input.path.id } }
		},
		create: async () => {
			createCalls++
			return { data: { id: "ses_child" } }
		},
	})

	assert.equal(await runTaskWithModel(client, { ...base, variant: " \n" }), "task_with_model: Variant must not be blank")
	assert.equal(getCalls, 1, "caller policy must be checked before input validation")
	assert.equal(createCalls, 0)
})

test("a child session cannot delegate again", async () => {
	let createCalls = 0
	const { client } = clientWith({
		get: async () => ({ data: { id: "ses_child", parentID: "ses_parent" } }),
		create: async () => {
			createCalls++
			return { data: { id: "ses_grandchild" } }
		},
	})

	assert.equal(
		await runTaskWithModel(client, base),
		"task_with_model: nested delegation is not available; do the work inline in this session",
	)
	assert.equal(createCalls, 0, "a nested call must not create a grandchild session")
})

test("a calling session lookup failure is reported before session creation", async () => {
	let createCalls = 0
	const { client } = clientWith({
		get: async () => ({ error: { message: "Calling session not found" } }),
		create: async () => {
			createCalls++
			return { data: { id: "ses_child" } }
		},
	})

	const result = await runTaskWithModel(client, base)
	assert.match(result, /^task_with_model: /)
	assert.match(result, /Calling session not found/)
	assert.equal(createCalls, 0)
})

test("a bad model string fails before any session is created", async () => {
	let createCalls = 0
	const { client } = clientWith({
		create: async () => {
			createCalls++
			return { data: { id: "ses_child" } }
		},
	})

	const result = await runTaskWithModel(client, { ...base, model: "claude-opus-5" })
	assert.match(result, /^task_with_model: /)
	assert.equal(createCalls, 0, "a typo must not leave an orphan child session behind")
})

test("a refused session creation is reported, not thrown", async () => {
	const { client } = clientWith({
		create: async () => ({ error: { message: "Parent session not found" } }),
	})

	const result = await runTaskWithModel(client, base)
	assert.match(result, /^task_with_model: /)
	assert.match(result, /Parent session not found/)
})

test("a session creation that throws is reported, not thrown", async () => {
	const { client } = clientWith({
		create: async () => {
			throw new Error("connection refused\nsocket details")
		},
	})

	assert.equal(await runTaskWithModel(client, base), "task_with_model: connection refused")
})

test("a refused prompt is reported and the child is stopped", async () => {
	const { client, aborted } = clientWith({
		prompt: async () => ({ error: { message: "model unavailable" } }),
	})

	const result = await runTaskWithModel(client, base)
	assert.match(result, /^task_with_model: /)
	assert.match(result, /model unavailable/)
	assert.deepEqual(aborted, ["ses_child"], "a child we gave up on must not be left running")
})

test("a cancelled prompt stops the child instead of leaving it running", async () => {
	// This is the interrupt path: the caller's turn was aborted, so the child
	// would otherwise keep working on an answer nobody can read.
	const { client, aborted } = clientWith({
		prompt: async () => {
			throw new Error("The operation was aborted")
		},
	})

	assert.equal(await runTaskWithModel(client, base), "task_with_model: The operation was aborted")
	assert.deepEqual(aborted, ["ses_child"])
})

test("a child turn that errored reports the reason and keeps partial output", async () => {
	const { client } = clientWith({
		prompt: async () => ({
			data: {
				info: { error: { name: "MessageAbortedError", data: { message: "aborted" } } },
				parts: [{ type: "text", text: "half an answer" }],
			},
		}),
	})

	const result = await runTaskWithModel(client, base)
	assert.match(result, /^task_with_model: MessageAbortedError: aborted/)
	assert.match(result, /half an answer/, "work already paid for should not be discarded")
})

test("a child turn that errored with nothing to show reports only the reason", async () => {
	const { client } = clientWith({
		prompt: async () => ({
			data: { info: { error: { name: "ProviderAuthError", data: { message: "no credentials" } } }, parts: [] },
		}),
	})

	assert.equal(await runTaskWithModel(client, base), "task_with_model: ProviderAuthError: no credentials")
})

test("an error carrying no message is still named", async () => {
	// MessageOutputLengthError has a name and nothing else; without it the
	// failure would be indistinguishable from a silent one.
	const { client } = clientWith({
		prompt: async () => ({ data: { info: { error: { name: "MessageOutputLengthError" } }, parts: [] } }),
	})

	assert.equal(await runTaskWithModel(client, base), "task_with_model: MessageOutputLengthError")
})

test("a child that finished silently says so rather than returning nothing", async () => {
	// An empty answer would read as success with no content, the one result a
	// caller cannot act on.
	const { client } = clientWith({
		prompt: async () => ({ data: { info: { finish: "stop" }, parts: [] } }),
	})

	const result = await runTaskWithModel(client, base)
	assert.match(result, /^task_with_model: /)
	assert.match(result, /ses_child/)
	assert.match(result, /stop/)
})

test("only what the model actually said becomes the answer", () => {
	assert.equal(
		joinTextParts([
			{ type: "text", text: "first" },
			{ type: "tool", text: "a tool call is not the answer" },
			{ type: "text", text: "injected", synthetic: true },
			{ type: "text", text: "dropped", ignored: true },
			{ type: "text", text: "   " },
			{ type: "text", text: "second" },
		]),
		"first\nsecond",
	)
})

test("tasks issued together run concurrently", async () => {
	// The reason the tool awaits a promise instead of blocking: sending one
	// prompt to several models at once is the main use. If the second call
	// could not start until the first finished, the tool would be pointless.
	let inFlight = 0
	let peak = 0
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})

	const { client } = clientWith({
		prompt: async () => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await gate
			inFlight--
			return { data: { parts: [{ type: "text", text: "done" }] } }
		},
	})

	const both = Promise.all([
		runTaskWithModel(client, base),
		runTaskWithModel(client, { ...base, model: "openai/gpt-5" }),
	])
	// Let both reach the prompt call before either is allowed to finish.
	await new Promise((resolve) => setImmediate(resolve))
	release()

	assert.deepEqual(await both, ["done", "done"])
	assert.equal(peak, 2, "the second task waited for the first instead of running alongside it")
})
