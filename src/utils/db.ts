// src/utils/db.ts
import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

// Singleton pattern — one Prisma client for the process lifetime.
// In test environments we create a fresh client per suite.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
  });

if (config.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function connectDb(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
