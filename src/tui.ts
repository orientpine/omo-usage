import type { AccountRow } from "./types.ts";
import { collectUsage } from "./collect.ts";
import { readAuthFile } from "./credentials.ts";
import { renderFrame, type AppState } from "./render.ts";

const ALT_SCREEN_ON = "\u001B[?1049h";
const ALT_SCREEN_OFF = "\u001B[?1049l";
const CURSOR_HIDE = "\u001B[?25l";
const CURSOR_SHOW = "\u001B[?25h";
const HOME = "\u001B[H";
const CLEAR_LINE = "\u001B[K";
const CLEAR_BELOW = "\u001B[J";

/** Anthropic usage 엔드포인트의 토큰당 쿨다운(약 95초)보다 길어야 자동 갱신마다 429를 맞지 않는다. */
const AUTO_REFRESH_MS = 150_000;
const TICK_MS = 1_000;

interface Mutable {
	rows: AccountRow[];
	updatedAt: number | null;
	refreshing: boolean;
	error: string | null;
}

function snapshot(state: Mutable): AppState {
	return { rows: state.rows, updatedAt: state.updatedAt, refreshing: state.refreshing, error: state.error, now: Date.now() };
}

function draw(state: Mutable): void {
	const cols = process.stdout.columns ?? 100;
	const rows = process.stdout.rows ?? 40;
	const frame = renderFrame(snapshot(state), cols).slice(0, Math.max(1, rows - 1));
	process.stdout.write(HOME + frame.map((line) => line + CLEAR_LINE).join("\n") + "\n" + CLEAR_BELOW);
}

export async function runTui(): Promise<void> {
	const state: Mutable = { rows: [], updatedAt: null, refreshing: false, error: null };

	// 파이프로 넘길 때는 TUI 대신 한 번만 출력한다.
	if (!process.stdout.isTTY) {
		const auth = await readAuthFile();
		state.rows = await collectUsage(auth);
		for (const line of renderFrame({ ...snapshot(state), updatedAt: Date.now() }, process.stdout.columns ?? 100)) console.log(line);
		return;
	}

	let inflight: AbortController | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const scheduleRetry = (): void => {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		const now = Date.now();
		const pending = state.rows.map((row) => row.retryAt ?? 0).filter((at) => at > now);
		if (pending.length === 0) return;
		retryTimer = setTimeout(() => void refresh(), Math.min(...pending) - now + 1_000);
	};

	const refresh = async (): Promise<void> => {
		if (state.refreshing) return;
		inflight?.abort();
		const controller = new AbortController();
		inflight = controller;
		state.refreshing = true;
		draw(state);
		try {
			const auth = await readAuthFile();
			const rows = await collectUsage(auth, { signal: controller.signal, previous: state.rows });
			if (controller.signal.aborted || closed) return;
			state.rows = rows;
			state.updatedAt = Date.now();
			state.error = null;
			scheduleRetry();
		} catch (error) {
			if (!closed) state.error = `조회 실패: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (inflight === controller) inflight = null;
			state.refreshing = false;
			if (!closed) draw(state);
		}
	};

	const tick = setInterval(() => !closed && draw(state), TICK_MS);
	const auto = setInterval(() => void refresh(), AUTO_REFRESH_MS);
	const onResize = (): void => draw(state);

	const quit = (code: number): void => {
		if (closed) return;
		closed = true;
		clearInterval(tick);
		clearInterval(auto);
		if (retryTimer) clearTimeout(retryTimer);
		inflight?.abort();
		process.stdout.off("resize", onResize);
		process.stdin.off("data", onKey);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
		process.exit(code);
	};

	function onKey(chunk: Buffer): void {
		const key = chunk.toString("utf8");
		if (key === "q" || key === "Q" || key === "\u0003" || key === "\u0004") quit(0);
		else if (key === "r" || key === "R") void refresh();
	}

	process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", onKey);
	process.stdout.on("resize", onResize);
	process.on("SIGINT", () => quit(0));
	process.on("SIGTERM", () => quit(0));

	draw(state);
	await refresh();
}
