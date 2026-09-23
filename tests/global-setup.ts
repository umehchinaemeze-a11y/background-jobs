import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "pg";

const require = createRequire(import.meta.url);

function runPrismaMigrateDeploy(env: NodeJS.ProcessEnv): void {
  // Run the Prisma CLI through node's JS entry point directly: spawning
  // `npx.cmd` via execFileSync fails on Windows (EINVAL for .cmd files).
  const cliEntry = require.resolve("prisma/build/index.js", {
    paths: [process.cwd()],
  });
  execFileSync(process.execPath, [cliEntry, "migrate", "deploy"], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}

/**
 * Loads test env (the vitest config already loaded .env.test), ensures the
 * test database exists, and applies migrations.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set for tests (check .env.test)");
  }
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1) || "postgres";

  // Connect to the maintenance database on the same server and create the
  // test database if it does not exist yet.
  const maintenance = new URL(url);
  maintenance.pathname = "/jobs";
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  const { rows } = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName],
  );
  if (rows.length === 0) {
    await client.query(
      `CREATE DATABASE "${dbName.replace(/"/g, '""')}"`,
    );
  }
  await client.end();

  // Keep the test schema in sync with committed migrations.
  runPrismaMigrateDeploy({ ...process.env, DATABASE_URL: url });
}