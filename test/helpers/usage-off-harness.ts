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
const settle = () => Bun.sleep(30);
let requests = 0;
globalThis.fetch = Object.assign(async () => {
	requests++;
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
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stdin.resume = () => process.stdin;
		const { runTui } = await import("../../src/tui.ts");
		await runTui();
		assert.equal(requests, 1, "opening the TUI requests usage");
		now += 900_000;
		for (const { fn } of [...timers]) fn();
		await settle();
		assert.equal(requests, 1, "elapsed time must not request usage or retry 429");
		assert.ok(timers.some(({ ms }) => ms === 5_000), "keep local pool reread");
		process.stdin.emit("data", Buffer.from("r"));
		await settle();
		assert.equal(requests, 2, "r explicitly requests usage after cooldown");
	}
} finally {
	process.stdin.pause();
}
