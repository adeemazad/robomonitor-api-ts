// src/server.ts
import { buildApp } from "./app.js";
import { config } from "./utils/config.js";
import { connectDb, disconnectDb } from "./utils/db.js";

async function main(): Promise<void> {
  const app = await buildApp();

  await connectDb();
  app.log.info("Database connected");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down...");
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
