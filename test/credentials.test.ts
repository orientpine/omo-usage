import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretsFrom } from "../src/credentials.ts";

/** senpi가 store "claude-cli"로 로그인한 계정: auth.json에는 토큰 없이 dirId만 있다. */
const AUTH = {
	"anthropic-subscription": {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		accounts: [
			{ name: "default", source: "login", store: "claude-cli", dirId: "aaa111" },
			{ name: "second", source: "login", store: "claude-cli", dirId: "bbb222" },
		],
	},
};

function claudeDir(tokens: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "omo-usage-claude-cli-test-"));
	for (const [dirId, token] of Object.entries(tokens)) {
		mkdirSync(join(dir, dirId));
		writeFileSync(join(dir, dirId, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "ref-SECRET" } }));
	}
	return dir;
}

describe("secretsFrom · claude-cli store", () => {
	test("auth.json에 토큰이 없으면 <dirId>/.credentials.json의 accessToken을 쓴다", () => {
		const secrets = secretsFrom(AUTH, claudeDir({ aaa111: "tok-a", bbb222: "tok-b" }));
		expect(secrets.get("anthropic-subscription/default")?.access).toBe("tok-a");
		expect(secrets.get("anthropic-subscription/second")?.access).toBe("tok-b");
	});

	test("credentials 파일이 없거나 깨진 계정만 빠지고 나머지는 그대로 나온다", () => {
		const dir = claudeDir({ aaa111: "tok-a" });
		mkdirSync(join(dir, "bbb222"));
		writeFileSync(join(dir, "bbb222", ".credentials.json"), "{not json");
		const secrets = secretsFrom(AUTH, dir);
		expect(secrets.get("anthropic-subscription/default")?.access).toBe("tok-a");
		expect(secrets.has("anthropic-subscription/second")).toBe(false);
	});

	test("auth.json에 토큰이 있으면 그 토큰이 우선이다", () => {
		const auth = { "anthropic-subscription": { accounts: [{ name: "default", store: "claude-cli", dirId: "aaa111", access: "tok-auth" }] } };
		expect(secretsFrom(auth, claudeDir({ aaa111: "tok-file" })).get("anthropic-subscription/default")?.access).toBe("tok-auth");
	});
});
