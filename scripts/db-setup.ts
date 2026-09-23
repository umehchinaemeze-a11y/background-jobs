import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "pg";

const require = createRequire(import.meta.url);

/**
 * Ensures the DATABASE_URL database exists and is migrated. Used by
 * `npm run db:setup` for the dev database (the vitest global setup applies
 * the same routine to the test database).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (check .env)");

  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1) || "postgres";

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  const { rows } = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName],
  );
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`created database "${dbName}"`);
  } else {
    console.log(`database "${dbName}" already exists`);
  }
  await client.end();

  // Run the Prisma CLI through node's JS entry point directly: spawning
  // `npx.cmd` via execFileSync fails on Windows (EINVAL for .cmd files).
  const cliEntry = require.resolve("prisma/build/index.js", {
    paths: [process.cwd()],
  });
  execFileSync(process.execPath, [cliEntry, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  console.log(`migrations applied to "${dbName}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});