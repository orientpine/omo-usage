import { collectUsage } from "./collect.ts";
import { readAuthFile, AUTH_PATH } from "./credentials.ts";
import { readPoolState } from "./pool.ts";
import { usageStamp } from "./render.ts";

const HELP = `omo-usage — remaining usage for every account logged in to omo-ai

Usage:
  omo-usage            run the TUI (r refresh · q quit)
  omo-usage --once     fetch once, print, and exit
  omo-usage --json     print JSON and exit (never includes tokens)
  omo-usage --help     this help

Credentials: ${AUTH_PATH} (read only)`;

function plain(rows: Awaited<ReturnType<typeof collectUsage>>, now: number): string {
	// provider id 길이가 senpi 버전마다 달라서(anthropic-subscription 22자) 고정 폭 대신 가장 긴 id에 맞춘다.
	const providerWidth = Math.max(0, ...rows.map((row) => row.provider.length));
	return rows
		.map((row) => {
			const windows = row.windows.map((w) => `${w.label} ${w.remainingPercent}% left`).join(" · ");
			const status = row.status === "ok" ? (row.note ? `${windows} · ${row.note}` : windows) : `${row.status.toUpperCase()}${row.detail ? ` (${row.detail})` : ""}`;
			const stamp = usageStamp(row, now);
			return `${row.provider.padEnd(providerWidth)} ${row.label.padEnd(12)} ${status}${stamp.text.length > 0 ? ` · ${stamp.text}` : ""}`;
		})
		.join("\n");
}

const args = new Set(Bun.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
	console.log(HELP);
	process.exit(0);
}

if (args.has("--json") || args.has("--once")) {
	const [auth, poolState] = await Promise.all([readAuthFile(), readPoolState()]);
	const rows = await collectUsage(auth, { poolState });
	console.log(args.has("--json") ? JSON.stringify(rows, null, 2) : plain(rows, Date.now()));
	process.exit(0);
}

const { runTui } = await import("./tui.ts");
await runTui();
