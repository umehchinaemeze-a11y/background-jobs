import { beforeEach } from "vitest";
import { prisma } from "../lib/prisma";

export async function resetDb(): Promise<void> {
  // TRUNCATE ... CASCADE also clears the (dependent) JobOutput table.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Job" CASCADE');
}

// Each test starts from a clean, migrated database.
beforeEach(async () => {
  await resetDb();
});