import type { AccountRow, UsageWindow } from "./types.ts";

export interface AppState {
	readonly rows: readonly AccountRow[];
	readonly updatedAt: number | null;
	readonly refreshing: boolean;
	readonly error: string | null;
	readonly now: number;
}

interface Part {
	readonly t: string;
	readonly c?: string;
}

const SGR = /\u001B\[[0-9;]*m/g;
const RESET = "\u001B[0m";

const DIM = "90";
const BOLD_CYAN = "1;36";
const BOLD_WHITE = "1;97";
/** 계정 첫 줄 앞의 마커와 이어지는 줄의 가이드. 둘 다 4칸이라 열 정렬을 흔들지 않는다. */
const MARKER = "  ● ";
const GUIDE = "  │ ";
const GREEN = "32";
const YELLOW = "33";
const RED = "31";

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
function compose(parts: readonly Part[], cols: number): string {
	let out = "";
	let width = 0;
	for (const part of parts) {
		if (width >= cols) break;
		const text = truncate(part.t, cols - width);
		if (text.length === 0) continue;
		width += displayWidth(text);
		out += part.c ? `\u001B[${part.c}m${text}${RESET}` : text;
	}
	return out;
}

function two(value: number): string {
	return value.toString().padStart(2, "0");
}

function clock(date: Date): string {
	return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 로캘에 따라 "7시 30분 0초" 같은 문자열이 나오지 않도록 직접 만든다. */
function stampOf(ms: number): string {
	const date = new Date(ms);
	return `${clock(date)}:${two(date.getSeconds())}`;
}

function relative(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "곧";
	if (minutes < 60) return `${minutes}분 뒤`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `${hours}시간 ${rest}분 뒤` : `${hours}시간 뒤`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours > 0 ? `${days}일 ${restHours}시간 뒤` : `${days}일 뒤`;
}

function formatReset(resetsAt: number | null, now: number): string {
	if (resetsAt === null) return "";
	const date = new Date(resetsAt);
	const today = new Date(now);
	const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
	const stamp = sameDay ? clock(date) : `${date.getMonth() + 1}/${date.getDate()} ${clock(date)}`;
	const diff = resetsAt - now;
	return diff <= 0 ? `${stamp} · 초기화됨` : `${stamp} · ${relative(diff)}`;
}

function levelColor(remaining: number): string {
	if (remaining >= 50) return GREEN;
	if (remaining >= 20) return YELLOW;
	return RED;
}

function bar(remaining: number, width: number): { filled: string; empty: string } {
	const filled = Math.round((Math.min(100, Math.max(0, remaining)) / 100) * width);
	return { filled: "█".repeat(filled), empty: "░".repeat(Math.max(0, width - filled)) };
}

function retryNote(row: AccountRow): string {
	return row.retryAt === undefined ? "" : ` · ${clock(new Date(row.retryAt))} 재시도`;
}

function statusText(row: AccountRow): string {
	const label =
		row.status === "expired" ? "만료" : row.status === "error" ? "오류" : row.status === "unsupported" ? "n/a" : row.status === "loading" ? "조회 중…" : "";
	return (row.detail ? `${label} · ${row.detail}` : label) + retryNote(row);
}

/** 429 등으로 이전 막대를 유지한 줄에는 왜 그런지와 언제 다시 시도하는지를 막대 옆에 적는다. */
function staleNote(row: AccountRow): string {
	return row.status === "ok" && row.detail ? `  ${row.detail}${retryNote(row)}` : "";
}

function accountTitle(row: AccountRow): string {
	return row.plan ? `${row.label} (${row.plan})` : row.label;
}

export function renderFrame(state: AppState, cols: number): string[] {
	const width = Math.max(40, cols);
	const lines: string[] = [];

	const stamp = state.updatedAt === null ? "조회 전" : stampOf(state.updatedAt);
	const ok = state.rows.filter((r) => r.status === "ok").length;
	const head = "  omo-ai 계정 사용량";
	const meta = `계정 ${state.rows.length} · 정상 ${ok} · 갱신 ${stamp}${state.refreshing ? " · 조회 중…" : ""}  `;
	const gap = Math.max(1, width - displayWidth(head) - displayWidth(meta));

	lines.push("");
	lines.push(compose([{ t: head, c: "1;97" }, { t: " ".repeat(gap) }, { t: meta, c: DIM }], width));
	lines.push(compose([{ t: "  " + "─".repeat(Math.max(0, width - 4)), c: DIM }], width));

	if (state.error) lines.push(compose([{ t: "  " }, { t: state.error, c: RED }], width));

	if (state.rows.length === 0) {
		lines.push("");
		lines.push(compose([{ t: "  로그인된 계정이 없습니다. omo TUI에서 /login 으로 먼저 로그인하세요.", c: YELLOW }], width));
	}

	const titleWidth = Math.min(24, Math.max(12, ...state.rows.map((r) => displayWidth(accountTitle(r)))));
	const windowWidth = Math.min(10, Math.max(3, ...state.rows.flatMap((r) => r.windows.map((w) => displayWidth(w.label))), 3));
	const barWidth = Math.max(6, Math.min(20, width - 4 - titleWidth - windowWidth - 30));

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

		if (row.windows.length === 0) {
			lines.push(
				compose(
					[
						{ t: MARKER, c: BOLD_WHITE },
						{ t: pad(accountTitle(row), titleWidth + 1), c: BOLD_WHITE },
						{ t: statusText(row), c: row.status === "unsupported" ? DIM : YELLOW },
					],
					width,
				),
			);
			continue;
		}

		row.windows.forEach((window: UsageWindow, index: number) => {
			const shape = bar(window.remainingPercent, barWidth);
			const color = levelColor(window.remainingPercent);
			lines.push(
				compose(
					[
						index === 0 ? { t: MARKER, c: BOLD_WHITE } : { t: GUIDE, c: DIM },
						{ t: pad(index === 0 ? accountTitle(row) : "", titleWidth + 1), c: BOLD_WHITE },
						{ t: pad(window.label, windowWidth + 1), c: DIM },
						{ t: shape.filled, c: color },
						{ t: shape.empty, c: DIM },
						{ t: ` ${window.remainingPercent.toString().padStart(3)}% `, c: color },
						{ t: formatReset(window.resetsAt, state.now), c: DIM },
						{ t: index === 0 ? staleNote(row) : "", c: YELLOW },
					],
					width,
				),
			);
		});

		if (row.note) {
			lines.push(compose([{ t: GUIDE, c: DIM }, { t: pad("", titleWidth + 1) }, { t: row.note, c: DIM }], width));
		}
	}

	lines.push("");
	lines.push(compose([{ t: "  [r] 새로고침   [q] 종료", c: DIM }], width));
	return lines;
}
