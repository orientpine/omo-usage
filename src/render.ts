import type { AccountRow, UsageWindow } from "./types.ts";

export interface AppState {
	readonly rows: readonly AccountRow[];
	readonly updatedAt: number | null;
	readonly refreshing: boolean;
	readonly error: string | null;
	readonly now: number;
}

export interface Part {
	readonly t: string;
	readonly c?: string;
}

const SGR = /\u001B\[[0-9;]*m/g;
const RESET = "\u001B[0m";

const DIM = "90";
const BOLD_CYAN = "1;36";
const BOLD_WHITE = "1;97";
/** 계정 첫 줄 앞의 마커와 이어지는 줄의 가이드. 전부 4칸이라 열 정렬을 흔들지 않는다. */
const MARKER = "  ● ";
const ACTIVE_MARKER = "  ▶ ";
const GUIDE = "  │ ";
const GREEN = "32";
const BOLD_GREEN = "1;32";
/** 이 시간 안에 성공 요청이 있었으면 senpi가 지금 그 계정을 쓰는 중으로 본다. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;
const YELLOW = "33";
const RED = "31";
/**
 * 막대 표시 방식은 asmond-lab/omo-usage(footer 확장)를 따른다: ▕█░▏ 고정 14칸, 레벨 색은 테마와 무관한 truecolor 세 가지,
 * 빈 칸은 회색, 남은 비율 > 50 초록 · 20..50 주황 · < 20 빨강 + "running out".
 */
export const BAR_CELLS = 14;
const LEVEL_GREEN = "38;2;74;222;128";
const LEVEL_AMBER = "38;2;251;191;36";
export const LEVEL_RED = "38;2;248;113;113";
export const BAR_EMPTY = "38;2;82;82;91";
const LOW_PERCENT = 20;

/** 동아시아 전각 문자는 터미널에서 2칸을 먹는다. 폭 계산이 틀리면 표가 깨진다. */
function charWidth(code: number): number {
	if (code === 0x200b || (code >= 0x0300 && code <= 0x036f)) return 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text.replace(SGR, "")) width += charWidth(ch.codePointAt(0) ?? 0);
	return width;
}

function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	let out = "";
	let width = 0;
	for (const ch of text) {
		const w = charWidth(ch.codePointAt(0) ?? 0);
		if (width + w > max) return out;
		out += ch;
		width += w;
	}
	return out;
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 색을 입히되 폭은 항상 평문 기준으로 계산해 cols를 절대 넘지 않게 한다. */
export function compose(parts: readonly Part[], cols: number): string {
	let out = "";
	let width = 0;
	for (const part of parts) {
		if (width >= cols) break;
		const fitted = truncate(part.t, cols - width);
		// 잘린 줄은 끝에 …를 달아 뒤에 내용이 더 있다는 것을 보여준다 (…는 1칸이라 cols를 넘지 않는다).
		const text = fitted === part.t ? fitted : truncate(part.t, cols - width - 1) + "…";
		if (text.length === 0) continue;
		width += displayWidth(text);
		out += part.c ? `\u001B[${part.c}m${text}${RESET}` : text;
	}
	return out;
}

function two(value: number): string {
	return value.toString().padStart(2, "0");
}

export function clock(date: Date): string {
	return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 로캘에 따라 "7시 30분 0초" 같은 문자열이 나오지 않도록 직접 만든다. */
function stampOf(ms: number): string {
	const date = new Date(ms);
	return `${clock(date)}:${two(date.getSeconds())}`;
}

function relative(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "soon";
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours > 0 ? `in ${days}d ${restHours}h` : `in ${days}d`;
}

/** 리셋 시각: 오늘이면 "16:00", 아니면 "09/22 14:00". */
export function resetStamp(resetsAt: number, now: number): string {
	const date = new Date(resetsAt);
	const today = new Date(now);
	const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
	return sameDay ? clock(date) : `${two(date.getMonth() + 1)}/${two(date.getDate())} ${clock(date)}`;
}

/** 계정별 마지막 성공 조회 시각. 공유 캐시라 실시간이 아니고, 429 동안에는 이 시각의 막대가 그대로 남는다. */
export function updatedStamp(fetchedAt: number, now: number): string {
	return `updated ${resetStamp(fetchedAt, now)}`;
}

function formatReset(resetsAt: number | null, now: number): string {
	if (resetsAt === null) return "";
	const stamp = resetStamp(resetsAt, now);
	const diff = resetsAt - now;
	return diff <= 0 ? `reset ${stamp}` : `resets ${stamp} · ${relative(diff)}`;
}

/** 참조 디자인의 꼬리: "88% left · resets …". 20% 미만이면 running out을 붙이되, 언제 돌아오는지 알 수 있게 리셋 시각은 지우지 않는다. */
function usageTail(window: UsageWindow, now: number): string {
	const details: string[] = [];
	if (window.remainingPercent < LOW_PERCENT) details.push("running out");
	const reset = formatReset(window.resetsAt, now);
	if (reset.length > 0) details.push(reset);
	return ` ${window.remainingPercent.toString().padStart(3)}% left${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

function elapsed(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export interface UsageStamp {
	readonly text: string;
	readonly active: boolean;
}

/**
 * 계정 선택이 세션별 해시라 "지금 이 계정 하나"라고 단정할 수 없다. 그래서 단정 대신 마지막 차감 시각을 적고,
 * 최근이면 사용 중으로 부른다 — 숫자가 옆에 있으니 읽는 사람이 판단할 수 있다.
 * pool 기록이 없는 provider(Codex·xAI)는 직전 조회 대비 잔여 감소가 근거라, 문구에 조회 시각과 감소 폭을 그대로 적는다.
 */
export function usageStamp(row: AccountRow, now: number): UsageStamp {
	if (row.lastUsedAt !== undefined) {
		const age = Math.max(0, now - row.lastUsedAt);
		const active = age <= ACTIVE_WINDOW_MS;
		return { text: active ? `in use · ${elapsed(age)}` : `last used ${elapsed(age)}`, active };
	}
	if (row.drained !== undefined) {
		const age = Math.max(0, now - row.drained.at);
		const active = age <= ACTIVE_WINDOW_MS;
		return { text: active ? `in use · -${row.drained.percent}% since poll ${elapsed(age)}` : `last drain seen ${elapsed(age)}`, active };
	}
	return { text: "", active: false };
}

export function levelColor(remaining: number): string {
	if (remaining > 50) return LEVEL_GREEN;
	if (remaining >= LOW_PERCENT) return LEVEL_AMBER;
	return LEVEL_RED;
}

function bar(remaining: number, width: number): { filled: string; empty: string } {
	const filled = Math.round((Math.min(100, Math.max(0, remaining)) / 100) * width);
	return { filled: "█".repeat(filled), empty: "░".repeat(Math.max(0, width - filled)) };
}

function retryNote(row: AccountRow): string {
	return row.retryAt === undefined ? "" : ` · retry ${clock(new Date(row.retryAt))}`;
}

function statusText(row: AccountRow): string {
	const label =
		row.status === "expired" ? "expired" : row.status === "error" ? "error" : row.status === "unsupported" ? "n/a" : row.status === "loading" ? "loading…" : "";
	return (row.detail ? `${label} · ${row.detail}` : label) + retryNote(row);
}

/** 429 등으로 이전 막대를 유지한 줄에는 왜 그런지와 언제 다시 시도하는지를 막대 옆에 적는다. */
function staleNote(row: AccountRow): string {
	return row.status === "ok" && row.detail ? `  ${row.detail}${retryNote(row)}` : "";
}

function accountTitle(row: AccountRow): string {
	return `${row.label}${row.plan ? ` (${row.plan})` : ""}${row.pinned ? " (pinned)" : ""}`;
}

export function renderFrame(state: AppState, cols: number): string[] {
	const width = Math.max(40, cols);
	const lines: string[] = [];

	const stamp = state.updatedAt === null ? "not yet" : stampOf(state.updatedAt);
	const ok = state.rows.filter((r) => r.status === "ok").length;
	const head = "  omo-ai account usage";
	const meta = `accounts ${state.rows.length} · ok ${ok} · updated ${stamp}${state.refreshing ? " · loading…" : ""}  `;
	const gap = Math.max(1, width - displayWidth(head) - displayWidth(meta));

	lines.push("");
	lines.push(compose([{ t: head, c: "1;97" }, { t: " ".repeat(gap) }, { t: meta, c: DIM }], width));
	lines.push(compose([{ t: "  " + "─".repeat(Math.max(0, width - 4)), c: DIM }], width));

	if (state.error) lines.push(compose([{ t: "  " }, { t: state.error, c: RED }], width));

	if (state.rows.length === 0) {
		lines.push("");
		lines.push(compose([{ t: "  No accounts logged in. Run /login in the omo TUI first.", c: YELLOW }], width));
	}

	const titleWidth = Math.min(24, Math.max(12, ...state.rows.map((r) => displayWidth(accountTitle(r)))));
	const windowWidth = Math.min(10, Math.max(3, ...state.rows.flatMap((r) => r.windows.map((w) => displayWidth(w.label))), 3));
	const barWidth = Math.max(6, Math.min(BAR_CELLS, width - 4 - titleWidth - windowWidth - 30));

	let provider: string | null = null;
	for (const row of state.rows) {
		if (row.provider !== provider) {
			provider = row.provider;
			lines.push("");
			lines.push(compose([{ t: "  " }, { t: provider, c: BOLD_CYAN }], width));
		} else {
			// 같은 provider 안에서 계정이 바뀔 때는 빈 줄로 블록을 나눈다.
			lines.push("");
		}

		const stamp = usageStamp(row, state.now);
		const marker: Part = stamp.active ? { t: ACTIVE_MARKER, c: BOLD_GREEN } : { t: MARKER, c: BOLD_WHITE };
		const updated = row.fetchedAt === undefined ? "" : updatedStamp(row.fetchedAt, state.now);
		const stampLine =
			stamp.text.length === 0 && updated.length === 0
				? null
				: compose(
						[
							{ t: GUIDE, c: DIM },
							{ t: pad("", titleWidth + 1) },
							{ t: stamp.text, c: stamp.active ? GREEN : DIM },
							{ t: stamp.text.length > 0 && updated.length > 0 ? ` · ${updated}` : updated, c: DIM },
						],
						width,
					);

		if (row.windows.length === 0) {
			lines.push(
				compose(
					[
						marker,
						{ t: pad(accountTitle(row), titleWidth + 1), c: BOLD_WHITE },
						{ t: statusText(row), c: row.status === "unsupported" ? DIM : YELLOW },
					],
					width,
				),
			);
			if (stampLine !== null) lines.push(stampLine);
			continue;
		}

		row.windows.forEach((window: UsageWindow, index: number) => {
			const shape = bar(window.remainingPercent, barWidth);
			const color = levelColor(window.remainingPercent);
			lines.push(
				compose(
					[
						index === 0 ? marker : { t: GUIDE, c: DIM },
						{ t: pad(index === 0 ? accountTitle(row) : "", titleWidth + 1), c: BOLD_WHITE },
						{ t: pad(window.label, windowWidth + 1), c: color },
						{ t: "▕" + shape.filled, c: color },
						{ t: shape.empty, c: BAR_EMPTY },
						{ t: "▏", c: color },
						{ t: usageTail(window, state.now), c: color },
						{ t: index === 0 ? staleNote(row) : "", c: YELLOW },
					],
					width,
				),
			);
		});

		if (row.note) {
			lines.push(compose([{ t: GUIDE, c: DIM }, { t: pad("", titleWidth + 1) }, { t: row.note, c: DIM }], width));
		}
		if (stampLine !== null) lines.push(stampLine);
	}

	lines.push("");
	lines.push(compose([{ t: "  [r] refresh   [q] quit", c: DIM }], width));
	return lines;
}
