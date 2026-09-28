import assert from "node:assert/strict"
import test from "node:test"
import {
	applyOverride,
	createTaskModelHooks,
	describeMismatch,
	describeRoute,
	ensureModelExists,
	extendTaskDefinition,
	findTaskCall,
	PendingOverrides,
	takeOverrideArgs,
	type SessionMessage,
	type TaskModelClient,
} from "./task-model.ts"

const opus = { providerID: "anthropic", modelID: "claude-opus-5" }

/** The built-in task tool's schema, trimmed to what matters here. */
function taskDefinition() {
	return {
		description: "Launch a new agent.",
		parameters: {},
		jsonSchema: {
			type: "object",
			properties: { description: { type: "string" }, prompt: { type: "string" }, subagent_type: { type: "string" } },
			required: ["description", "prompt", "subagent_type"],
		} as Record<string, any>,
	}
}

/** A `task` tool part as the built-in leaves it on the parent's message. */
function taskPart(callID: string, sessionId: string | undefined) {
	return { type: "tool", tool: "task", callID, state: { metadata: sessionId ? { sessionId } : {} } }
}

function userMessage(model: { providerID: string; modelID: string; variant?: string }, created = 1): SessionMessage {
	return { info: { role: "user", time: { created }, model }, parts: [] }
}

function assistantMessage(providerID: string, modelID: string, created = 2, variant?: string): SessionMessage {
	return { info: { role: "assistant", time: { created }, providerID, modelID, variant }, parts: [] }
}

test("the task definition gains optional model and variant arguments", () => {
	const output = taskDefinition()
	assert.equal(extendTaskDefinition(output), true)
	assert.deepEqual(Object.keys(output.jsonSchema.properties), [
		"description",
		"prompt",
		"subagent_type",
		"model",
		"variant",
	])
	// Both stay optional: existing callers and subtask commands send neither.
	assert.deepEqual(output.jsonSchema.required, ["description", "prompt", "subagent_type"])
	assert.match(output.description, /`model`/)
})

test("the registry's own schema object is left untouched", () => {
	// The hook gets the stored definition's schema; editing it in place would
	// change the definition for every later request.
	const output = taskDefinition()
	const original = output.jsonSchema
	extendTaskDefinition(output)
	assert.notEqual(output.jsonSchema, original)
	assert.deepEqual(Object.keys(original.properties), ["description", "prompt", "subagent_type"])
})

test("extending the description twice adds the note once", () => {
	const output = taskDefinition()
	extendTaskDefinition(output)
	const once = output.description
	extendTaskDefinition(output)
	assert.equal(output.description, once)
})

test("a definition without a JSON Schema is left alone", () => {
	const output = { description: "Launch a new agent.", parameters: {} }
	assert.equal(extendTaskDefinition(output), false)
	assert.deepEqual(output, { description: "Launch a new agent.", parameters: {} })
})

test("model and variant are read and removed from the call's arguments", () => {
	const args: Record<string, unknown> = {
		prompt: "p",
		subagent_type: "general",
		model: "openrouter/meta-llama/llama-3",
		variant: " high ",
	}
	assert.deepEqual(takeOverrideArgs(args), {
		model: { providerID: "openrouter", modelID: "meta-llama/llama-3" },
		variant: "high",
	})
	// The built-in never sees arguments it doesn't declare.
	assert.deepEqual(args, { prompt: "p", subagent_type: "general" })
})

test("a call without either argument has no override", () => {
	assert.equal(takeOverrideArgs({ prompt: "p" }), undefined)
	assert.equal(takeOverrideArgs({ prompt: "p", model: null }), undefined)
	assert.equal(takeOverrideArgs(undefined), undefined)
})

test("a variant alone is an override", () => {
	assert.deepEqual(takeOverrideArgs({ variant: "low" }), { variant: "low" })
})

test("malformed overrides fail the call", () => {
	for (const bad of [{ model: "claude-opus-5" }, { model: "/x" }, { model: "x/" }, { model: 3 }]) {
		assert.throws(() => takeOverrideArgs(bad), /provider\/model|must be a string/, JSON.stringify(bad))
	}
	assert.throws(() => takeOverrideArgs({ variant: "  " }), /must not be blank/)
	assert.throws(() => takeOverrideArgs({ variant: 1 }), /must be a string/)
})

function providersClient(data: unknown, error?: unknown): TaskModelClient {
	return {
		session: {
			get: async () => ({}),
			messages: async () => ({}),
		},
		config: { providers: async () => ({ data: data as any, error }) },
	}
}

test("a configured model passes the existence check", async () => {
	const client = providersClient({ providers: [{ id: "anthropic", models: { "claude-opus-5": {} } }] })
	await ensureModelExists(client, opus)
})

test("an unknown provider or model fails the existence check", async () => {
	const client = providersClient({ providers: [{ id: "openai", models: {} }, { id: "anthropic", models: {} }] })
	await assert.rejects(ensureModelExists(client, { providerID: "antrophic", modelID: "x" }), /unknown provider.*anthropic, openai/)
	await assert.rejects(ensureModelExists(client, opus), /has no model "claude-opus-5"/)
})

test("the existence check stands aside when providers can't be listed", async () => {
	await ensureModelExists(providersClient(undefined, { message: "boom" }), opus)
})

test("a pending override is claimed only once", () => {
	const pending = new PendingOverrides()
	pending.add("call_1", { model: opus })
	assert.deepEqual(pending.claim("call_1"), { model: opus, variant: undefined })
	assert.equal(pending.claim("call_1"), undefined)
	assert.equal(pending.claim("call_unknown"), undefined)
})

test("finishing a call removes its override", () => {
	const pending = new PendingOverrides()
	pending.add("call_1", { model: opus })
	pending.claim("call_1")
	assert.deepEqual(pending.finish("call_1", false), { model: opus, variant: undefined, applied: true })
	assert.equal(pending.size, 0)
})

test("a background call keeps its override until the child claims it", () => {
	// In background mode the tool returns before the child is prompted.
	const pending = new PendingOverrides()
	pending.add("call_1", { model: opus })
	assert.deepEqual(pending.finish("call_1", true), { model: opus, variant: undefined, applied: false })
	assert.equal(pending.has("call_1"), true)
	assert.deepEqual(pending.claim("call_1"), { model: opus, variant: undefined })
	assert.equal(pending.size, 0)
})

test("stale overrides of failed calls are dropped", () => {
	// A failed call never reaches tool.execute.after, so nothing else removes it.
	let now = 0
	const pending = new PendingOverrides(() => now)
	pending.add("call_failed", { model: opus })
	now = 2 * 60 * 60 * 1000
	pending.add("call_new", { model: opus })
	assert.equal(pending.has("call_failed"), false)
	assert.equal(pending.has("call_new"), true)
})

test("a child is matched to its call by session ID, not by prompt", () => {
	// Two calls with the same prompt in one message, as parallel calls are.
	const messages: SessionMessage[] = [
		{ info: { role: "user" }, parts: [{ type: "text" }] },
		{ info: { role: "assistant" }, parts: [taskPart("call_a", "ses_a"), taskPart("call_b", "ses_b")] },
	]
	const pending = new Set(["call_a", "call_b"])
	assert.equal(findTaskCall(messages, "ses_b", (id) => pending.has(id)), "call_b")
	assert.equal(findTaskCall(messages, "ses_a", (id) => pending.has(id)), "call_a")
})

test("calls that aren't pending, other tools and unrelated sessions don't match", () => {
	const messages: SessionMessage[] = [
		{
			info: { role: "assistant" },
			parts: [
				taskPart("call_done", "ses_a"),
				{ type: "tool", tool: "bash", callID: "call_bash", state: { metadata: { sessionId: "ses_a" } } },
				taskPart("call_early", undefined),
			],
		},
	]
	assert.equal(findTaskCall(messages, "ses_a", (id) => id !== "call_done"), undefined)
	assert.equal(findTaskCall(messages, "ses_other", () => true), undefined)
})

test("a new model replaces the old one and drops its variant", () => {
	const current = { providerID: "openai", modelID: "gpt-6", variant: "xhigh" }
	assert.deepEqual(applyOverride(current, { model: opus }), opus)
	assert.deepEqual(applyOverride(current, { model: opus, variant: "max" }), { ...opus, variant: "max" })
})

test("a variant alone keeps the model", () => {
	const current = { providerID: "openai", modelID: "gpt-6", variant: "xhigh" }
	assert.deepEqual(applyOverride(current, { variant: "low" }), { providerID: "openai", modelID: "gpt-6", variant: "low" })
})

test("a child on the requested model and variant raises no warning", () => {
	const messages = [userMessage({ ...opus, variant: "high" }), assistantMessage("anthropic", "claude-opus-5", 2, "high")]
	assert.equal(describeMismatch({ model: opus, variant: "high" }, messages), undefined)
})

test("a child on another model or variant raises a warning naming the fallback", () => {
	const messages = [userMessage({ providerID: "openai", modelID: "gpt-6" }), assistantMessage("openai", "gpt-6")]
	const warning = describeMismatch({ model: opus, variant: "high" }, messages)
	assert.match(warning ?? "", /requested model anthropic\/claude-opus-5 but the subagent ran on openai\/gpt-6/)
	assert.match(warning ?? "", /requested variant high but the subagent ran with none/)
	assert.match(warning ?? "", /task_with_model/)
})

test("the newest message decides, whatever order they are listed in", () => {
	const messages = [assistantMessage("anthropic", "claude-opus-5", 5), userMessage({ providerID: "openai", modelID: "gpt-6" }, 1)]
	assert.equal(describeMismatch({ model: opus }, messages), undefined)
})

test("a child with no messages yet raises no warning", () => {
	assert.equal(describeMismatch({ model: opus }, []), undefined)
})

/**
 * A fake server holding sessions and their messages, enough to run the hooks
 * the way OpenCode calls them for one task call.
 */
function fakeServer() {
	const parents: Record<string, string | undefined> = { ses_parent: undefined }
	const messages: Record<string, SessionMessage[]> = { ses_parent: [] }
	const limits: Array<number | undefined> = []
	const client: TaskModelClient = {
		session: {
			get: async (input) => ({ data: { id: input.path.id, parentID: parents[input.path.id] } }),
			messages: async (input) => {
				limits.push(input.query?.limit)
				const all = messages[input.path.id] ?? []
				return { data: input.query?.limit ? all.slice(-input.query.limit) : all }
			},
		},
		config: {
			providers: async () => ({
				data: { providers: [{ id: "anthropic", models: { "claude-opus-5": {} } }, { id: "openai", models: { "gpt-6": {} } }] },
			}),
		},
	}
	/** What the built-in does before prompting the child: create it and publish its ID. */
	function startChild(callID: string, childID: string) {
		parents[childID] = "ses_parent"
		messages.ses_parent.push({ info: { role: "assistant" }, parts: [taskPart(callID, childID)] })
	}
	return { client, messages, startChild, limits }
}

const defaultModel = () => ({ model: { providerID: "openai", modelID: "gpt-6" } })

test("the child's first message runs on the model its call asked for", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	const args = { description: "d", prompt: "same", subagent_type: "general", model: "anthropic/claude-opus-5", variant: "high" }
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args })
	assert.deepEqual(args, { description: "d", prompt: "same", subagent_type: "general" })

	server.startChild("call_1", "ses_child")
	const first = { message: defaultModel() }
	await hooks["chat.message"]({ sessionID: "ses_child" }, first)
	assert.deepEqual(first.message.model, { ...opus, variant: "high" })

	// A later message in the same child, for example a task_id resume without
	// a model, is left alone.
	const second = { message: defaultModel() }
	await hooks["chat.message"]({ sessionID: "ses_child" }, second)
	assert.deepEqual(second.message.model, defaultModel().model)
})

test("parallel calls with identical prompts each get their own model", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_a" }, { args: { prompt: "same", model: "anthropic/claude-opus-5" } })
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_b" }, { args: { prompt: "same", model: "openai/gpt-6" } })
	server.messages.ses_parent.push({ info: { role: "assistant" }, parts: [taskPart("call_a", "ses_a"), taskPart("call_b", "ses_b")] })
	server.startChild("call_a", "ses_a")
	server.startChild("call_b", "ses_b")

	const b = { message: { model: { providerID: "x", modelID: "y" } } }
	const a = { message: { model: { providerID: "x", modelID: "y" } } }
	await hooks["chat.message"]({ sessionID: "ses_b" }, b)
	await hooks["chat.message"]({ sessionID: "ses_a" }, a)
	assert.deepEqual(a.message.model, opus)
	assert.deepEqual(b.message.model, { providerID: "openai", modelID: "gpt-6" })
})

test("an unknown model fails the call before anything is recorded", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await assert.rejects(
		hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { model: "anthropic/claude-opus-9" } }),
		/has no model/,
	)
	server.startChild("call_1", "ses_child")
	const output = { message: defaultModel() }
	await hooks["chat.message"]({ sessionID: "ses_child" }, output)
	assert.deepEqual(output.message.model, defaultModel().model)
})

test("calls without an override and other tools cost no lookups", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { prompt: "p" } })
	const args = { model: "anthropic/claude-opus-5" }
	await hooks["tool.execute.before"]({ tool: "bash", callID: "call_2" }, { args })
	assert.deepEqual(args, { model: "anthropic/claude-opus-5" })
	await hooks["chat.message"]({ sessionID: "ses_parent" }, { message: defaultModel() })
	assert.deepEqual(server.limits, [])
})

test("an old calling message is still found", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { model: "anthropic/claude-opus-5" } })
	server.startChild("call_1", "ses_child")
	for (let i = 0; i < 20; i++) server.messages.ses_parent.push({ info: { role: "user" }, parts: [] })
	const output = { message: defaultModel() }
	await hooks["chat.message"]({ sessionID: "ses_child" }, output)
	assert.deepEqual(output.message.model, opus)
	assert.deepEqual(server.limits, [10, undefined])
})

test("the route line names the model and the variant, or its absence", () => {
	assert.equal(describeRoute({ ...opus, variant: "high" }), "task-model: ran on anthropic/claude-opus-5, variant high")
	assert.equal(describeRoute(opus), "task-model: ran on anthropic/claude-opus-5, no variant")
})

test("a finished call on the right model gets its metadata fixed, its route and no warning", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { model: "anthropic/claude-opus-5", variant: "high" } })
	server.startChild("call_1", "ses_child")
	await hooks["chat.message"]({ sessionID: "ses_child" }, { message: defaultModel() })
	server.messages.ses_child = [userMessage({ ...opus, variant: "high" }), assistantMessage("anthropic", "claude-opus-5", 2, "high")]

	const output = { output: "<task>answer</task>", metadata: { sessionId: "ses_child", model: defaultModel().model } }
	await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output)
	assert.equal(output.output, "task-model: ran on anthropic/claude-opus-5, variant high\n\n<task>answer</task>")
	assert.deepEqual(output.metadata.model, opus)
})

test("a call without an override gets no route line", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { prompt: "p" } })
	server.startChild("call_1", "ses_child")
	server.messages.ses_child = [userMessage(defaultModel().model), assistantMessage("openai", "gpt-6")]
	const output = { output: "<task>answer</task>", metadata: { sessionId: "ses_child" } }
	await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output)
	assert.equal(output.output, "<task>answer</task>")
})

test("a child that ran on the wrong model is reported in the output", async () => {
	// What a future OpenCode that ignores the chat.message change would do.
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { model: "anthropic/claude-opus-5" } })
	server.startChild("call_1", "ses_child")
	await hooks["chat.message"]({ sessionID: "ses_child" }, { message: defaultModel() })
	server.messages.ses_child = [userMessage(defaultModel().model), assistantMessage("openai", "gpt-6")]

	const output: { output: string; metadata: Record<string, unknown> } = {
		output: "<task>answer</task>",
		metadata: { sessionId: "ses_child" },
	}
	await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output)
	assert.match(output.output, /^task: requested model anthropic\/claude-opus-5 but the subagent ran on openai\/gpt-6/)
	// The warning comes first, then the route the child really ran on.
	assert.match(output.output, /\ntask-model: ran on openai\/gpt-6, no variant\n\n<task>answer<\/task>$/)
	// The metadata tells the truth rather than what was asked for.
	assert.deepEqual(output.metadata.model, { providerID: "openai", modelID: "gpt-6" })
})

test("an override that never reached its child is reported in the output", async () => {
	// What a future OpenCode that stops publishing sessionId early would do.
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { variant: "high" } })
	server.messages.ses_child = [userMessage(defaultModel().model)]
	const output = { output: "done", metadata: { sessionId: "ses_child" } }
	await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output)
	assert.match(output.output, /^task: requested variant high/)
})

test("a background call is not checked before its child starts, and still gets its model", async () => {
	const server = fakeServer()
	const hooks = createTaskModelHooks(server.client)
	await hooks["tool.execute.before"]({ tool: "task", callID: "call_1" }, { args: { model: "anthropic/claude-opus-5" } })
	server.startChild("call_1", "ses_child")
	const output = { output: "started", metadata: { sessionId: "ses_child", background: true } }
	await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output)
	assert.equal(output.output, "started")

	const first = { message: defaultModel() }
	await hooks["chat.message"]({ sessionID: "ses_child" }, first)
	assert.deepEqual(first.message.model, opus)
})

test("a missing schema is reported once", async () => {
	const warnings: string[] = []
	const hooks = createTaskModelHooks(fakeServer().client, { warn: (message) => warnings.push(message) })
	await hooks["tool.definition"]({ toolID: "task" }, { description: "d", parameters: {} })
	await hooks["tool.definition"]({ toolID: "task" }, { description: "d", parameters: {} })
	await hooks["tool.definition"]({ toolID: "bash" }, { description: "d", parameters: {} })
	assert.equal(warnings.length, 1)
})
