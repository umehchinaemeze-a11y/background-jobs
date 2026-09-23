import { prisma } from "./common";

const SCRIPTS = [
  "scripts/breakit/01-concurrency.ts",
  "scripts/breakit/02-failure-to-dead.ts",
  "scripts/breakit/03-worker-kill-recovery.ts",
  "scripts/breakit/04-idempotency.ts",
  "scripts/breakit/05-two-workers.ts",
  "scripts/breakit/06-live-api.ts",
  "scripts/breakit/07-resend-smoke.ts",
];

async function main(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const results: { script: string; code: number; ms: number }[] = [];
  for (const script of SCRIPTS) {
    const t = Date.now();
    try {
      execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", script], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: "inherit",
      });
      results.push({ script, code: 0, ms: Date.now() - t });
      console.log(`\n✓ ${script} (${(Date.now() - t) / 1000}s)\n`);
    } catch (e) {
      const code = (e as { status?: number }).status ?? 1;
      results.push({ script, code, ms: Date.now() - t });
      console.error(`\n✗ ${script} exited ${code} after ${(Date.now() - t) / 1000}s\n`);
    }
  }
  console.log("\n=== break-it suite summary ===");
  for (const r of results) {
    console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.script}  (${(r.ms / 1000).toFixed(1)}s)`);
  }
  const failed = results.filter((r) => r.code !== 0).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main();