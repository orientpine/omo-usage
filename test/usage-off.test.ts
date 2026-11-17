import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ledger enforced.by token: USAGE_AUTO_REFRESH_OFF
for (const mode of ["periodic", "retry", "footer"]) {
	test(`USAGE_AUTO_REFRESH_OFF: ${mode} only requests on explicit action`, async () => {
		const root = await mkdtemp(join(tmpdir(), "usage-off-"));
		try {
			const child = Bun.spawn(["bun", new URL("./helpers/usage-off-harness.ts", import.meta.url).pathname, mode], {
				env: { ...process.env, HOME: root },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = await new Response(child.stderr).text();
			expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: "" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
