import { createHash } from "node:crypto";
import type { AccountRow, UsageWindow } from "./types.ts";
import { collectUsage } from "./collect.ts";
import { readAuthFile } from "./credentials.ts";
import { readPoolState } from "./pool.ts";
import { BAR_CELLS, BAR_EMPTY, LEVEL_RED, clock, compose, displayWidth, levelColor, resetStamp, type Part } from "./render.ts";

/** 소유자가 정한 조회 간격 (2026-10-01): Anthropic usage의 토큰당 429 창(약 95초)과 대시보드 TUI(150초)에 겹쳐도 429를 피할 만큼 넉넉하게. */
export const FOOTER_REFRESH_MS = 300_000;
/** footer가 다시 그려 달라고 요청할 때 쓰는 상태 키. 값 없이 지우는 것이 확장 API의 repaint 요청이다 (asmond-lab/omo-usage와 같은 방식). */
const STATUS_KEY = "zz-omo-usage";
const MIN_BAR_CELLS = 4;
const LOW_PERCENT = 20;
const DIM = "90";
const BOLD_WHITE = "1;97";
const YELLOW = "33";
const SEPARATOR: Part = { t: " │ ", c: DIM };
/** pool 칸 높이: 그 계정을 가장 먼저 막는 창의 남은 비율을 8단계로. */
const CELL_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	"anthropic-subscription": "Claude",
	"claude-sdk-oauth": "Claude",
	"chatgpt-subscription": "Codex",
	"openai-codex": "Codex",
	xai: "xAI",
	"kimi-coding": "Kimi",
};

export interface FooterFocus {
	readonly provider: string;
	/** 지금 세션이 쓰는 슬롯. 알 수 없으면 null — 그때는 ①을 단정하지 않고 pool에 그 provider의 모든 계정을 보인다. */
	readonly slot: string | null;
}

function providerName(provider: string): string {
	return PROVIDER_NAMES[provider] ?? provider;
}

/** 계정을 가장 먼저 막는 창 = 남은 비율이 가장 낮은 창. 창이 셋이어도 실제로 사용을 멈추게 하는 건 이것 하나다. */
export function bindingWindow(row: AccountRow): UsageWindow | null {
	let low: UsageWindow | null = null;
	for (const window of row.windows) if (low === null || window.remainingPercent < low.remainingPercent) low = window;
	return low;
}

/** 재로그인이 필요한 계정: refresh 실패(auth.ts expiredDetail) 또는 401/403(collect.ts httpDetail). 그 외 만료는 senpi가 알아서 갱신한다. */
function needsRelogin(row: AccountRow): boolean {
	return row.detail !== null && (row.detail.startsWith("refresh failed") || row.detail.includes("re-login required"));
}

function widthOf(parts: readonly Part[]): number {
	return parts.reduce((sum, part) => sum + displayWidth(part.t), 0);
}

/** ① 지금 계정: 이름 + 막는 창의 막대·비율·창 이름 (+ 리셋 시각, 429면 재시도 시각). 창이 없으면 막대 대신 사유. */
function headParts(row: AccountRow, name: string, cells: number, withReset: boolean, now: number): Part[] {
	const window = bindingWindow(row);
	if (window === null) {
		const reason = needsRelogin(row) ? "re-login needed" : row.status === "loading" ? "loading…" : row.status;
		return [
			{ t: name, c: BOLD_WHITE },
			{ t: ` ${reason}`, c: YELLOW },
		];
	}
	const color = levelColor(window.remainingPercent);
	const filled = Math.round((Math.min(100, Math.max(0, window.remainingPercent)) / 100) * cells);
	const parts: Part[] = [
		{ t: `${name} ▕${"█".repeat(filled)}`, c: color },
		{ t: "░".repeat(cells - filled), c: BAR_EMPTY },
		{ t: `▏ ${window.remainingPercent}% ${window.label}`, c: color },
	];
	if (!withReset) return parts;
	// 429로 이전 값을 붙들고 있으면 리셋보다 "언제 다시 묻는지"가 중요하다.
	if (row.retryAt !== undefined) parts.push({ t: ` · retry ${clock(new Date(row.retryAt))}`, c: YELLOW });
	else if (window.resetsAt !== null) parts.push({ t: ` · resets ${resetStamp(window.resetsAt, now)}`, c: color });
	return parts;
}

/** ② pool 한 칸: 높이 = 막는 창의 남은 비율, 색 = 레벨. 창이 없으면 ✗ (재로그인/오류는 빨강, 자동 갱신될 만료는 노랑). */
function poolCell(row: AccountRow): Part {
	const window = bindingWindow(row);
	if (window === null) return { t: "✗", c: needsRelogin(row) || row.status === "error" ? LEVEL_RED : YELLOW };
	const index = Math.min(CELL_CHARS.length - 1, Math.floor((Math.max(0, window.remainingPercent) / 100) * CELL_CHARS.length));
	return { t: CELL_CHARS[index] ?? "▁", c: levelColor(window.remainingPercent) };
}

/** ③ 예외: 다른 provider 중 빨강(20% 미만)이거나 재로그인이 필요한 계정만. 첫 하나를 보이고 나머지는 +N. */
function alertParts(rows: readonly AccountRow[], provider: string): Part[] {
	const alerts = rows.filter((row) => row.provider !== provider && (needsRelogin(row) || (bindingWindow(row)?.remainingPercent ?? 100) < LOW_PERCENT));
	const first = alerts[0];
	if (first === undefined) return [];
	const window = bindingWindow(first);
	const what = window !== null && window.remainingPercent < LOW_PERCENT ? `${window.label} ${window.remainingPercent}%` : "re-login";
	const parts: Part[] = [SEPARATOR, { t: `⚠ ${providerName(first.provider)}·${first.label} ${what}`, c: LEVEL_RED }];
	if (alerts.length > 1) parts.push({ t: ` +${alerts.length - 1}`, c: LEVEL_RED });
	return parts;
}

/**
 * footer 한 줄 = ① 지금 계정 + ② 같은 provider의 나머지 계정 + ③ 다른 provider의 예외.
 * 폭이 모자라면 ③ → ② → 리셋 시각 → 막대 길이 순으로 덜어내고, 그래도 안 되면 …로 자른다. 결과는 절대 cols를 넘지 않는다.
 * 그 provider에 조회할 계정이 없으면 빈 문자열 (줄을 그리지 않는다).
 */
export function renderFooter(rows: readonly AccountRow[], focus: FooterFocus, cols: number, now: number): string {
	const mine = rows.filter((row) => row.provider === focus.provider && row.status !== "unsupported");
	if (mine.length === 0 || cols <= 0) return "";

	const name = providerName(focus.provider);
	const current = focus.slot === null ? undefined : mine.find((row) => row.slot === focus.slot);
	const others = current === undefined ? mine : mine.filter((row) => row !== current);
	const pool: Part[] = others.length === 0 ? [] : [SEPARATOR, { t: "pool ", c: DIM }, ...others.map(poolCell)];
	const alerts = alertParts(rows, focus.provider);
	const head = (cells: number, withReset: boolean): Part[] =>
		current === undefined ? [{ t: name, c: BOLD_WHITE }] : headParts(current, `${name}·${current.label}`, cells, withReset, now);

	const variants: Part[][] = [[...head(BAR_CELLS, true), ...pool, ...alerts], [...head(BAR_CELLS, true), ...pool], head(BAR_CELLS, true), head(BAR_CELLS, false)];
	for (let cells = BAR_CELLS - 1; cells >= MIN_BAR_CELLS; cells--) variants.push(head(cells, false));
	const fit = variants.find((parts) => widthOf(parts) <= cols) ?? variants[variants.length - 1] ?? [];
	return compose(fit, cols);
}

export interface PollerDeps {
	readonly readAuth?: () => Promise<unknown>;
	readonly readPool?: () => Promise<unknown>;
	readonly fetchImpl?: typeof fetch;
	readonly now?: () => number;
	readonly setTimer?: (fn: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	/** auth.json을 못 읽는 등 조회 자체가 실패했을 때. 이전 값은 그대로 남는다. */
	readonly onError?: (message: string) => void;
}

export interface UsagePoller {
	readonly rows: () => readonly AccountRow[];
	readonly start: () => void;
	readonly stop: () => void;
	readonly refresh: () => Promise<void>;
}

function realTimer(fn: () => void, ms: number): unknown {
	const handle = setTimeout(fn, ms);
	// footer 타이머 때문에 senpi 프로세스가 끝나지 못하면 안 된다.
	handle.unref();
	return handle;
}

/**
 * FOOTER_REFRESH_MS마다 모든 계정을 다시 조회한다. 직전 결과를 previous로 넘기므로 collectUsage가
 * retryAt 전인 계정은 부르지 않고, 429면 이전 막대를 지운 대신 retryAt만 덧붙인다.
 */
export function createUsagePoller(onRows: (rows: readonly AccountRow[]) => void, deps: PollerDeps = {}): UsagePoller {
	const readAuth = deps.readAuth ?? (() => readAuthFile());
	const readPool = deps.readPool ?? (() => readPoolState());
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimer ?? realTimer;
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let rows: readonly AccountRow[] = [];
	let timer: unknown;
	let running = false;
	let inflight: Promise<void> | null = null;

	const refresh = (): Promise<void> => {
		if (inflight) return inflight;
		inflight = (async () => {
			try {
				const [auth, poolState] = await Promise.all([readAuth(), readPool()]);
				rows = await collectUsage(auth, { previous: rows, now: now(), poolState, fetchImpl: deps.fetchImpl });
				if (running) onRows(rows);
			} catch (error) {
				deps.onError?.(error instanceof Error ? error.message : String(error));
			} finally {
				inflight = null;
			}
		})();
		return inflight;
	};

	const schedule = (): void => {
		timer = setTimer(() => {
			timer = undefined;
			void refresh().finally(() => {
				if (running) schedule();
			});
		}, FOOTER_REFRESH_MS);
	};

	return {
		rows: () => rows,
		refresh,
		start: () => {
			if (running) return;
			running = true;
			void refresh();
			schedule();
		},
		stop: () => {
			running = false;
			if (timer !== undefined) clearTimer(timer);
			timer = undefined;
		},
	};
}

interface ModelLike {
	readonly provider: string;
	readonly id: string;
}

/** senpi ExtensionContext 중 이 확장이 쓰는 부분만 (senpi 2026.9.30 core/extensions/types.d.ts:351,355, core/model-registry.d.ts:26). */
export interface ExtensionContextLike {
	readonly hasUI: boolean;
	readonly model?: ModelLike | undefined;
	readonly modelRegistry: {
		readonly authStorage?: { get(provider: string): unknown } | undefined;
	};
	readonly sessionManager?: { getSessionId(): string } | undefined;
	readonly ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
}

export interface ExtensionApiLike {
	on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => unknown): void;
}

interface FooterClass {
	readonly prototype: { render(width: number): string[] };
}

/** 호스트(senpi)가 주는 것: 내장 footer 컴포넌트와 그 TUI의 폭 계산으로 자르는 함수. 둘 다 없으면 공유 상태줄로 대신한다. */
export interface FooterHost {
	readonly FooterComponent?: FooterClass | undefined;
	readonly fit?: ((text: string, width: number) => string) | undefined;
}

/** 모든 확장 인스턴스(/reload 포함)가 공유하는, footer 아래에 붙일 줄. */
let footerLine: (width: number) => string = () => "";
const patchedFooters = new WeakSet<FooterClass>();

/**
 * senpi에는 footer에 줄을 "덧붙이는" API가 없다: setStatus는 모든 확장이 한 줄을 나눠 써서 막대가 잘리고, setFooter는 내장 footer를 통째로 바꾼다.
 * 그래서 asmond-lab/omo-usage처럼 내장 FooterComponent의 render 결과 뒤에 한 줄을 붙인다 — 내장 footer는 그대로 그려진다.
 */
function appendFooterLine(component: FooterClass, fit: FooterHost["fit"]): void {
	if (patchedFooters.has(component)) return;
	patchedFooters.add(component);
	const render = component.prototype.render;
	component.prototype.render = function renderWithUsage(this: unknown, width: number): string[] {
		const lines = render.call(this, width);
		const line = footerLine(width);
		if (line.length === 0) return lines;
		return [...lines, fit ? fit(line, width) : line];
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * senpi 내장 footer가 `(provider@slot)`으로 보여주는 바로 그 슬롯을 같은 규칙으로 다시 계산한다
 * (senpi 2026.9.30 dist/modes/interactive/components/footer.js:46 accountFooterSuffix, pi-ai dist/auth/pool/select.js rendezvousOrder):
 * 고정(pinned) 슬롯이 있으면 그것, 아니면 sha256(`세션id\0슬롯이름`) 앞 8바이트(big-endian)가 가장 큰 슬롯 — 동점이면 앞선 슬롯.
 * senpi에는 현재 슬롯을 돌려주는 API가 없고, getApiKeyAndHeaders는 계정 토큰이 아니라 `<provider>-managed` 표식을 준다 (2026-10-01 실측).
 */
export function sessionSlot(credential: unknown, sessionId: string | null): string | null {
	const entry = record(credential);
	if (!entry) return null;
	const accounts = Array.isArray(entry["accounts"]) ? entry["accounts"] : [];
	const names =
		accounts.length > 0
			? accounts.flatMap((account) => {
					const name = record(account)?.["name"];
					return typeof name === "string" && name.length > 0 ? [name] : [];
				})
			: ["default"];
	const pinned = entry["pinned"];
	if (typeof pinned === "string" && names.includes(pinned)) return pinned;
	if (sessionId === null) return names.length === 1 ? (names[0] ?? null) : null;
	let winner: string | null = null;
	let best = -1n;
	for (const name of names) {
		const score = createHash("sha256").update(`${sessionId}\0${name}`).digest().readBigUInt64BE(0);
		if (score > best) {
			winner = name;
			best = score;
		}
	}
	return winner;
}

/** 지금 세션의 provider와 슬롯. 자격증명은 senpi가 메모리에 든 authStorage를 먼저 쓰고, 없으면 auth.json을 읽는다 (어느 쪽도 쓰지 않는다). */
async function resolveFocus(ctx: ExtensionContextLike, readAuth: () => Promise<unknown>): Promise<FooterFocus | null> {
	const model = ctx.model;
	if (!model) return null;
	// auth.json을 못 읽으면 슬롯을 단정하지 않는다(null = pool에 전부 표시). 읽기 실패 자체는 조회기가 onError로 알린다.
	const credential = ctx.modelRegistry.authStorage?.get(model.provider) ?? record(await readAuth().catch(() => null))?.[model.provider];
	return { provider: model.provider, slot: sessionSlot(credential, ctx.sessionManager?.getSessionId() ?? null) };
}

/** senpi 확장 팩토리. 타이머·조회는 session_start에서 시작하고 session_shutdown에서 멈춘다 (팩토리에서 시작하지 않는다). */
export function createFooterExtension(host: FooterHost, deps: PollerDeps = {}): (pi: ExtensionApiLike) => void {
	return function omoUsageFooter(pi: ExtensionApiLike): void {
		const now = deps.now ?? Date.now;
		const readAuth = deps.readAuth ?? (() => readAuthFile());
		let poller: UsagePoller | null = null;
		let focus: FooterFocus | null = null;
		let latest: ExtensionContextLike | null = null;
		let lastError: string | null = null;
		let redraw = (): void => {};

		const lineFor = (width: number): string => (poller !== null && focus !== null ? renderFooter(poller.rows(), focus, width, now()) : "");

		const refocus = async (ctx: ExtensionContextLike): Promise<void> => {
			latest = ctx;
			focus = await resolveFocus(ctx, readAuth);
			redraw();
		};

		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			latest = ctx;
			if (host.FooterComponent) {
				appendFooterLine(host.FooterComponent, host.fit);
				footerLine = lineFor;
				redraw = () => ctx.ui.setStatus(STATUS_KEY, undefined);
			} else {
				// 내장 footer를 못 받으면 공유 상태줄에라도 보인다 (다른 확장 상태와 한 줄을 나눠 써서 잘릴 수 있다).
				redraw = () => ctx.ui.setStatus(STATUS_KEY, lineFor(process.stdout.columns ?? 120) || undefined);
			}
			poller = createUsagePoller(
				() => {
					if (latest !== null) void refocus(latest);
				},
				{
					...deps,
					onError: (message) => {
						if (message === lastError) return;
						lastError = message;
						ctx.ui.notify(`omo-usage: ${message}`, "warning");
					},
				},
			);
			poller.start();
			await refocus(ctx);
		});
		pi.on("model_select", (_event, ctx) => refocus(ctx));
		// senpi가 실패 시 다른 계정으로 넘길 수 있으니 답이 끝날 때마다 슬롯만 다시 맞춘다 (사용량 조회는 하지 않는다).
		pi.on("agent_end", (_event, ctx) => refocus(ctx));
		pi.on("session_shutdown", () => {
			poller?.stop();
			poller = null;
			focus = null;
			latest = null;
			footerLine = () => "";
			redraw();
			redraw = () => {};
		});
	};
}
