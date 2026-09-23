// Loads .env for the standalone worker process. Skipped when the environment
// already supplies values (e.g. when a script spawns the worker with a custom
// DATABASE_URL). Must be imported before any module that reads config or
// instantiates the Prisma client.

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the process environment.
  }
}

export {};