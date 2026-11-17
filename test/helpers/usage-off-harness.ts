import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.HOME!;
const mode = process.argv[2];
let now = Date.UTC(2026, 10, 17);
const auth = { "anthropic-subscription": { access: "fake", expires: now + 86_400_000 } };
const timers: { fn: () => void; ms: number }[] = [];
const timer = (fn: () => void, ms: number) => {
	const handle = { fn, ms, unref() {} };
	timers.push(handle);
	return handle;
};
// Watchdog uses the real clock; simulated timers must never control the test timeout.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
async function bounded<T>(event: Promise<T>, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([event, new Promise<never>((_, reject) => {
			timeout = realSetTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
		})]);
	} finally {
		if (timeout !== undefined) realClearTimeout(timeout);
	}
}
let requests = 0;
let onRequest = (): void => {};
globalThis.fetch = Object.assign(async () => {
	requests++;
	onRequest();
	return mode === "retry"
		? new Response("{}", { status: 429, headers: { "retry-after": "120" } })
		: Response.json({ five_hour: { utilization: 12, resets_at: new Date(now + 3_600_000).toISOString() } });
}, { preconnect: fetch.preconnect }) as typeof fetch;
Date.now = () => now;
globalThis.setInterval = timer as unknown as typeof setInterval;
globalThis.setTimeout = timer as unknown as typeof setTimeout;
globalThis.clearInterval = (() => {}) as typeof clearInterval;
globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
process.env.HOME = root;
process.env.OMO_USAGE_CACHE_DIR = join(root, "cache");
await mkdir(join(root, ".omo/agent"), { recursive: true });
await Bun.write(join(root, ".omo/agent/auth.json"), JSON.stringify(auth));

try {
	if (mode === "footer") {
		const { createUsagePoller } = await import("../../src/footer.ts");
		const poller = createUsagePoller(() => {}, {
			readAuth: async () => auth,
			cachePath: join(root, "cache/usage.json"),
			now: () => now,
		});
		poller.start();
		await poller.refresh();
		now += 900_000;
		for (const { fn } of [...timers]) fn();
		await poller.refresh();
		assert.equal(requests, 0, "footer must never request usage, even with an empty cache");
		poller.stop();
	} else {
		Object.defineProperty(process.stdout, "isTTY", { value: true });
		Object.defineProperty(process.stdout, "columns", { value: 200 });
		let refreshing = false;
		let onIdle = (): void => {};
		let onDraw = (): void => {};
		process.stdout.write = ((chunk: unknown) => {
			const frame = String(chunk);
			if (frame.includes(" · loading…")) refreshing = true;
			else if (refreshing) {
				refreshing = false;
				onIdle();
			}
			onDraw();
			return true;
		}) as typeof process.stdout.write;
		process.stdin.resume = () => process.stdin;
		const { runTui } = await import("../../src/tui.ts");
		await runTui();
		assert.equal(requests, 1, "opening the TUI requests usage");
		now += 900_000;
		for (const { fn, ms } of [...timers]) {
			const drawn = Promise.withResolvers<void>();
			const idle = Promise.withResolvers<void>();
			onDraw = drawn.resolve;
			onIdle = idle.resolve;
			fn();
			// A regressed refresh starts with a loading frame. Wait for its final
			// idle frame, so even a slow request cannot evade the negative check.
			if (refreshing) await bounded(idle.promise, "timer refresh completion");
			else if (ms === 5_000) await bounded(drawn.promise, "local pool reread draw");
		}
		assert.equal(requests, 1, "elapsed time must not request usage or retry 429");
		assert.ok(timers.some(({ ms }) => ms === 5_000), "keep local pool reread");
		const requested = Promise.withResolvers<void>();
		const idle = Promise.withResolvers<void>();
		onRequest = requested.resolve;
		onIdle = idle.resolve;
		process.stdin.emit("data", Buffer.from("r"));
		await bounded(Promise.all([requested.promise, idle.promise]), "manual request and refresh completion");
		assert.equal(requests, 2, "r explicitly requests usage after cooldown");
	}
} finally {
	process.stdin.pause();
}
