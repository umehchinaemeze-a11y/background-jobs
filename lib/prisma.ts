import { PrismaClient } from "@prisma/client";

// Single Prisma client reused across request handlers and the worker process.
// The global cache prevents connection exhaustion during Next.js dev reloads.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}