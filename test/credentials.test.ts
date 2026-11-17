import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectShared } from "../src/cache.ts";
import { readAuthFile } from "../src/credentials.ts";

const NOW = Date.UTC(2026, 10, 6, 12);
const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "fake-cli-access-SECRET";
const roots: string[] = [];
const BODY = { seven_day: { utilization: 73, resets_at: "2026-11-07T18:00:00Z" } };

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(account: Record<string, unknown> = {}, contents = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 60_000 } })) {
	const root = await mkdtemp(join(tmpdir(), "omo-usage-cli-test-"));
	roots.push(root);
	const dir = join(root, "anthropic-subscription-claude", ID);
	await mkdir(dir, { recursive: true });
	const file = join(dir, ".credentials.json");
	await writeFile(file, contents);
	const authPath = join(root, "auth.json");
	await writeFile(authPath, JSON.stringify({
		"anthropic-subscription": {
			access: "claude-sdk-oauth-managed",
			accounts: [{ name: "cli", store: "claude-cli", dirId: ID, ...account }],
		},
		"openai-codex": { access: "fake-legacy-access", expires: NOW + 60_000 },
	}));
	return { root, dir, file, authPath };
}

async function collect(authPath: string, root: string) {
	const sent: string[] = [];
	const fetchImpl: typeof fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
		const token = new Headers(init?.headers).get("authorization");
		if (token !== null) sent.push(token);
		return Response.json(token === "Bearer fake-legacy-access"
			? { plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } }
			: BODY);
	}, { preconnect: fetch.preconnect });
	const auth = await readAuthFile(authPath);
	const rows = await collectShared(auth, { now: NOW, fetchImpl, cachePath: join(root, "cache.json"), senpiUsagePath: join(root, "none.json") });
	return { rows, sent };
}

describe("Claude CLI credential file contract", () => {
	test("reads the CLI store over stale inline fields and preserves legacy accounts without writing credentials or leaking secrets", async () => {
		const { root, file, authPath } = await fixture({ access: "stale-inline-SECRET", expires: 1 });
		const before = await Promise.all([readFile(authPath, "utf8"), readFile(file, "utf8")]);
		const { rows, sent } = await collect(authPath, root);
		expect(rows.map((row) => [row.slot, row.status, row.windows[0]?.remainingPercent])).toEqual([["cli", "ok", 27], ["default", "ok", 88]]);
		expect(rows[0]?.expiresAt).toBe(NOW + 60_000);
		expect(sent.sort()).toEqual(["Bearer fake-cli-access-SECRET", "Bearer fake-legacy-access"]);
		expect(await Promise.all([readFile(authPath, "utf8"), readFile(file, "utf8")])).toEqual(before);
		const output = JSON.stringify(rows) + await readFile(join(root, "cache.json"), "utf8");
		for (const secret of [TOKEN, "stale-inline-SECRET", "fake-legacy-access", "claude-sdk-oauth-managed"]) expect(output).not.toContain(secret);
	});

	test.each([
		["missing", "", "missing"],
		["malformed", "{fake-SECRET", "file"],
		["wrong shape", JSON.stringify({ accessToken: TOKEN }), "file"],
		["empty token", JSON.stringify({ claudeAiOauth: { accessToken: "" } }), "file"],
		["sentinel", JSON.stringify({ claudeAiOauth: { accessToken: "claude-sdk-oauth-managed" } }), "file"],
		["refresh placeholder", JSON.stringify({ claudeAiOauth: { refreshToken: TOKEN } }), "file"],
		["expired", JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW - 1 } }), "file"],
		["boundary expiry", JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW } }), "file"],
		["linked file", "", "file-link"],
		["linked directory", "", "dir-link"],
	] as const)("does not send credentials from %s", async (_label, contents, shape) => {
		const { root, dir, file, authPath } = await fixture({ access: "stale-inline-SECRET", expires: NOW + 60_000 }, contents);
		if (shape === "missing") await rm(file);
		if (shape === "file-link") {
			await rm(file);
			const outside = join(root, "outside.json");
			await writeFile(outside, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
			await symlink(outside, file);
		}
		if (shape === "dir-link") {
			await rm(dir, { recursive: true });
			const outside = join(root, "outside");
			await mkdir(outside);
			await writeFile(join(outside, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
			await symlink(outside, dir);
		}
		const { rows, sent } = await collect(authPath, root);
		expect(sent).toEqual(["Bearer fake-legacy-access"]);
		expect(rows[0]?.status).toBe(shape === "file" && (_label === "expired" || _label === "boundary expiry") ? "expired" : "error");
		expect(rows[0]?.windows).toEqual([]);
		expect(JSON.stringify(rows)).not.toContain("SECRET");
	});

	test.each(["../outside", ID.toUpperCase(), `${ID}/..`, "", null])("refuses invalid directory id %s without inline fallback", async (dirId) => {
		const { root, authPath } = await fixture({ dirId, access: TOKEN, expires: NOW + 60_000 });
		const { rows, sent } = await collect(authPath, root);
		expect(sent).toEqual(["Bearer fake-legacy-access"]);
		expect(rows[0]?.status).toBe("error");
	});

	test("accepts a valid CLI file without an expiry, as the installed reader does", async () => {
		const { root, authPath } = await fixture({}, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
		const { rows } = await collect(authPath, root);
		expect(rows[0]?.status).toBe("ok");
		expect(rows[0]?.expiresAt).toBeNull();
	});
});
