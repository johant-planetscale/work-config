/**
 * Minimal Mode - collapse all intermediary tool calls and thinking into a
 * single summary line per turn. Only the agent's direct replies remain.
 *
 * What this does:
 *   - Hides every tool row entirely (call + result render to zero height).
 *   - Counts tool calls as they execute; shows a live count in the footer
 *     ("N tool calls…") that updates as the turn progresses.
 *   - Detects whether the assistant produced any thinking content.
 *   - On turn settle, writes one permanent summary entry into the transcript:
 *     "42 tool calls and some thinking…"
 *   - Relies on `hideThinkingBlock: true` (set in settings.json) to collapse
 *     thinking blocks to a single label, customized via
 *     `ctx.ui.setHiddenThinkingLabel("some thinking")`.
 *
 * Tool execution itself is unchanged — results still go to the LLM. Only the
 * TUI rendering is suppressed.
 *
 * Reload after editing: /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// External skill discovery (the-process)
// ---------------------------------------------------------------------------
// the-process ships skills but its installer has no pi path. Contribute its
// skills/ directory via resources_discover so pi scans the checkout directly.
// Override the checkout location with THE_PROCESS_DIR; default is the standard
// clone path. The dir is existence-checked so a missing checkout is a no-op.
const THE_PROCESS_DIR = process.env.THE_PROCESS_DIR || join(process.env.HOME || "", "code", "the-process");

// ---------------------------------------------------------------------------
// Built-in tool delegation (cached per cwd)
// ---------------------------------------------------------------------------

const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

// ---------------------------------------------------------------------------
// Per-turn accounting
// ---------------------------------------------------------------------------

interface TurnState {
	toolCalls: number;
	hadThinking: boolean;
}

let turn: TurnState = { toolCalls: 0, hadThinking: false };
let summaryWritten = false;

function summaryText(state: TurnState): string {
	const n = state.toolCalls;
	if (n === 0) return state.hadThinking ? "some thinking…" : "";
	const calls = `${n} tool call${n === 1 ? "" : "s"}`;
	const thinking = state.hadThinking ? " and some thinking" : "";
	return `${calls}${thinking}…`;
}

function hasSummary(state: TurnState): boolean {
	return state.toolCalls > 0 || state.hadThinking;
}

function hasThinkingContent(message: unknown): boolean {
	const msg = message as { content?: unknown } | undefined;
	const content = msg?.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) => typeof part === "object" && part !== null && (part as { type?: string }).type === "thinking",
	);
}

// Zero-height row. renderShell: "self" bypasses the default Box; an empty
// Container renders no lines. Both renderCall and renderResult return this so
// neither slot falls back to built-in rendering (which would show output).
const EMPTY = () => new Container();
const emptyRender = () => EMPTY();

// ---------------------------------------------------------------------------
// Tool descriptions (kept explicit so we don't depend on internal shapes)
// ---------------------------------------------------------------------------

const DESCRIPTIONS: Record<string, string> = {
	read: "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
	bash: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
	edit: "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
	write: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	find: "Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
	grep: "Search file contents by regex pattern. Uses ripgrep for fast searching. Output limited to 200 matches.",
	ls: "List directory contents with file sizes. Shows files and directories with their sizes. Output limited to 500 entries.",
};

// ===========================================================================
export default function (pi: ExtensionAPI) {
	// --- Hide thinking content (display-only; LLM still sees it) -------------
	// Returning "" for assistant-thinking markdown removes its visible output.
	// If a thinking-block frame still leaks after this, fall back to setting
	// `hideThinkingBlock: true` in settings.json.
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType === "assistant-thinking") return "";
		return markdown;
	});

	// --- External skills: the-process --------------------------------------
	// the-process's installer detects Claude/Codex/Cursor but not pi, so its
	// skills never land in ~/.pi/agent/skills. Point pi at the checkout's
	// skills/ dir directly so they load and track the repo.
	pi.on("resources_discover", async (_event, _ctx) => {
		const skillsDir = join(THE_PROCESS_DIR, "skills");
		if (existsSync(skillsDir)) {
			return { skillPaths: [skillsDir] };
		}
		return {};
	});

	// --- Turn lifecycle ------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		turn = { toolCalls: 0, hadThinking: false };
		summaryWritten = false;
		if (ctx.hasUI) ctx.ui.setStatus("minimal", summaryText(turn) || "…");

		// GLM (via Fireworks) tends to narrate its reasoning as plain text
		// instead of using native thinking blocks. That text is indistinguishable
		// from a real answer, so the minimal-mode renderer can't hide it. Nudge it
		// to keep reasoning internal and deliver only conclusions.
		const model = ctx.model;
		const isGlm =
			model?.provider === "fireworks" &&
			typeof model?.id === "string" &&
			model.id.toLowerCase().includes("glm");
		if (isGlm) {
			const nudge =
				"\n\nDo not narrate your reasoning process in your response. Do not walk the user through your thinking step by step. Deliver only the conclusion and the information asked for. If you need to reason, do it silently and report only the result.";
			return { systemPrompt: event.systemPrompt + nudge };
		}
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		turn.toolCalls += 1;
		if (ctx.hasUI) ctx.ui.setStatus("minimal", summaryText(turn));
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		if (hasThinkingContent(msg)) {
			turn.hadThinking = true;
		}
		// Strip thinking from the stored message so the settled re-render adds no
		// thinking run and no surrounding spacers — removes the stray blank lines
		// the markdown transformer alone leaves behind.
		//
		// Guarded: Anthropic and Bedrock require prior thinking blocks (with
		// signatures) to be preserved alongside tool_use in later requests, so
		// stripping could cause API rejections there. Skip for those providers.
		const provider = ctx.model?.provider ?? "";
		if (provider === "anthropic" || provider === "amazon-bedrock") return;
		if (!Array.isArray(msg.content) || !msg.content.some((c) => c?.type === "thinking")) return;
		const stripped = {
			...msg,
			content: msg.content.filter((c) => c?.type !== "thinking"),
		};
		return { message: stripped };
	});

	// Stamp the summary BEFORE the next assistant message enters the session.
	// This places it above the final reply rather than below it. Fires once per
	// turn; if no subsequent assistant message_start happens (e.g. thinking was
	// inside the final message with no prior tools), the agent_settled fallback
	// below catches it.
	pi.on("message_start", async (event, _ctx) => {
		if (event.message?.role !== "assistant") return;
		if (summaryWritten) return;
		if (!hasSummary(turn)) return;
		pi.appendEntry<TurnState>("turn-summary", { ...turn });
		summaryWritten = true;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("minimal", undefined);
		if (!summaryWritten && hasSummary(turn)) {
			pi.appendEntry<TurnState>("turn-summary", { ...turn });
		}
		turn = { toolCalls: 0, hadThinking: false };
		summaryWritten = false;
	});

	// --- Permanent transcript summary line ----------------------------------

	pi.registerEntryRenderer<TurnState>("turn-summary", (entry, _options, theme) => {
		const data = entry.data ?? { toolCalls: 0, hadThinking: false };
		return new Text(theme.fg("muted", summaryText(data)), 1, 0);
	});

	// --- Tool overrides: suppress all rendering, keep execution -------------

	const registerSilent = (name: "read" | "bash" | "edit" | "write" | "find" | "grep" | "ls") => {
		pi.registerTool({
			name,
			label: name,
			description: DESCRIPTIONS[name],
			parameters: getBuiltInTools(process.cwd())[name].parameters,
			renderShell: "self",
			renderCall: emptyRender,
			renderResult: emptyRender,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const tools = getBuiltInTools(ctx.cwd);
				return tools[name].execute(toolCallId, params, signal, onUpdate);
			},
		});
	};

	(["read", "bash", "edit", "write", "find", "grep", "ls"] as const).forEach(registerSilent);
}
