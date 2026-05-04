// src/utils/config.ts
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().default("file:./dev.db"),
  JWT_SECRET: z.string().min(16).default("change-me-in-production-min-32-chars!!"),
  JWT_EXPIRES_IN: z.string().default("1h"),
  // Anomaly detection tuning
  ANOMALY_WINDOW: z.coerce.number().default(30),
  ANOMALY_Z_THRESHOLD: z.coerce.number().default(3.5),
  ANOMALY_CONTAMINATION: z.coerce.number().default(0.05),
  // WebSocket
  WS_HEARTBEAT_MS: z.coerce.number().default(10_000),
  // Simulator
  SIMULATOR_HZ: z.coerce.number().default(10),
});

function loadConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment config:", result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;
