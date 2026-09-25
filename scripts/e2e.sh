#!/usr/bin/env bash
# End-to-end check of the task model overrides against a real OpenCode.
#
# Runs `opencode serve` with only src/task-model-plugin.ts installed, talking
# to openai-fake-provider (https://github.com/llucax/openai-fake-provider), so
# no request reaches a real model. Everything OpenCode stores goes to a
# temporary directory, removed at the end unless KEEP=1.
#
# Needs: opencode, curl, jq, python3, and the fake provider, either as an
# `openai-fake-provider` command or through OPENAI_FAKE_PROVIDER, the path to
# its openai_fake_provider.py.
#
# The fake model answers a line `CALL <tool> <json>` in the prompt with that
# tool call, which is how the parent is made to call `task`.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/task-model-e2e.XXXXXX")
pids=()
cleanup() {
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
	wait 2>/dev/null || true
	if [[ ${KEEP:-} == 1 ]]; then echo "kept $tmp"; else rm -rf "$tmp"; fi
}
trap cleanup EXIT

if [[ -n ${OPENAI_FAKE_PROVIDER:-} ]]; then
	fake=(python3 "$OPENAI_FAKE_PROVIDER")
elif command -v openai-fake-provider >/dev/null; then
	fake=(openai-fake-provider)
else
	echo "e2e: openai-fake-provider not found; set OPENAI_FAKE_PROVIDER" >&2
	exit 2
fi

free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
fake_port=$(free_port)
server_port=$(free_port)
server=http://127.0.0.1:$server_port

failures=0
check() { # description, then a command that must succeed; its output is dropped
	local what=$1
	shift
	if "$@" >/dev/null; then
		echo "ok   $what"
	else
		echo "FAIL $what"
		failures=$((failures + 1))
	fi
}

wait_for() { # url
	for _ in $(seq 150); do
		curl -sf --max-time 5 -o /dev/null "$1" && return 0
		sleep 0.2
	done
	echo "e2e: $1 did not come up" >&2
	return 1
}

# A config directory with this plugin as its only plugin, and a subtask
# command to check that commands still reach the built-in unchanged.
mkdir -p "$tmp/config/plugins" "$tmp/config/command" "$tmp/work" "$tmp/dump" "$tmp/xdg"/{config,data,state,cache}
ln -s "$repo/src/task-model-plugin.ts" "$tmp/config/plugins/task-model.ts"
cat >"$tmp/config/command/sub.md" <<'EOF'
---
description: subtask command
subtask: true
agent: general
---
Answer for the subtask command.
EOF

"${fake[@]}" serve --port "$fake_port" --dump-dir "$tmp/dump" 2>"$tmp/fake.log" &
pids+=($!)
wait_for "http://127.0.0.1:$fake_port/v1/models"

(
	# The fake provider's config makes fake/* the only usable models.
	export OPENCODE_CONFIG_CONTENT
	OPENCODE_CONFIG_CONTENT=$("${fake[@]}" opencode-config --port "$fake_port")
	export OPENCODE_CONFIG_DIR=$tmp/config
	export XDG_CONFIG_HOME=$tmp/xdg/config XDG_DATA_HOME=$tmp/xdg/data
	export XDG_STATE_HOME=$tmp/xdg/state XDG_CACHE_HOME=$tmp/xdg/cache
	export OPENCODE_DISABLE_CLAUDE_CODE=1
	unset OPENCODE_CONFIG OPENCODE OPENCODE_PID
	# Not a git repository: in a fresh one OpenCode was seen hanging before
	# the first model request.
	cd "$tmp/work"
	exec opencode serve --print-logs --hostname 127.0.0.1 --port "$server_port"
) >"$tmp/server.log" 2>&1 &
pids+=($!)
wait_for "$server/agent"

new_session() { curl -sf -X POST "$server/session" -H 'content-type: application/json' -d '{}' | jq -r .id; }

# Make the parent (on fake/ok) call task with the given JSON arguments.
call_task() { # session, args-json
	local body
	body=$(jq -n --arg text "CALL task $2" \
		'{agent: "build", model: {providerID: "fake", modelID: "ok"}, parts: [{type: "text", text: $text}]}')
	curl -sf --max-time 120 -X POST "$server/session/$1/message" -H 'content-type: application/json' -d "$body" >/dev/null
}

task_part() { # session: the task tool part of the parent
	curl -sf "$server/session/$1/message" | jq -c '[.[].parts[] | select(.type == "tool" and .tool == "task")] | last'
}

child_messages() { # session: the child's messages, reduced to their models
	local child
	child=$(task_part "$1" | jq -r .state.metadata.sessionId)
	curl -sf "$server/session/$child/message" |
		jq -c '[.[].info | {role, model: (.model.modelID // .modelID), variant: (.model.variant // .variant)}]'
}

# 1. The model sees the new arguments.
s=$(new_session)
call_task "$s" '{"description": "default", "prompt": "no override", "subagent_type": "general"}'
first=$(ls "$tmp"/dump/*-prompt.json | head -1)
check "task schema has model and variant" \
	jq -e '.tools[] | select(.function.name == "task") | .function.parameters.properties | has("model") and has("variant")' "$first"

# 2. Without an override the child keeps the default model.
check "no override: child on fake/ok" \
	test "$(child_messages "$s")" = '[{"role":"user","model":"ok","variant":null},{"role":"assistant","model":"ok","variant":null}]'

# 3. With one, the child runs on the requested model and variant, with no warning.
s=$(new_session)
call_task "$s" '{"description": "override", "prompt": "with override", "subagent_type": "general", "model": "fake/stats", "variant": "high"}'
check "override: child on fake/stats, variant high" \
	test "$(child_messages "$s")" = '[{"role":"user","model":"stats","variant":"high"},{"role":"assistant","model":"stats","variant":"high"}]'
part=$(task_part "$s")
check "override: call completed without a warning" \
	jq -e '.state.status == "completed" and (.state.output | startswith("<task"))' <<<"$part"
check "override: metadata reports fake/stats" \
	jq -e '.state.metadata.model.modelID == "stats"' <<<"$part"
check "override: fake provider got a request for stats" \
	jq -se 'map(.model) | index("stats") != null' "$tmp"/dump/*-prompt.json

# 4. An unknown model fails the call and creates no child.
s=$(new_session)
call_task "$s" '{"description": "bad", "prompt": "bad model", "subagent_type": "general", "model": "fake/nope"}'
check "unknown model: call fails naming the model" \
	jq -e '.state.status == "error" and (.state.error | test("no model \"nope\""))' <<<"$(task_part "$s")"
check "unknown model: no child session" \
	test "$(curl -sf "$server/session/$s/children" | jq length)" = 0

# 5. A subtask command still runs through the built-in.
s=$(new_session)
curl -sf --max-time 120 -X POST "$server/session/$s/command" -H 'content-type: application/json' \
	-d '{"command": "sub", "arguments": "", "agent": "build", "model": "fake/ok"}' >/dev/null
check "subtask command: completed" \
	jq -e '.state.status == "completed" and .state.input.command == "sub"' <<<"$(task_part "$s")"

if ((failures)); then
	echo "$failures check(s) failed; rerun with KEEP=1 to inspect $tmp" >&2
	exit 1
fi
echo "all checks passed"
