// src/middleware/schemas.ts
import { z } from "zod";

// ── Auth ──────────────────────────────────────────────────────────────────────
export const registerSchema = z.object({
  username: z.string().min(3).max(64),
  email:    z.string().email(),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

// ── Robots ────────────────────────────────────────────────────────────────────
export const createRobotSchema = z.object({
  name:        z.string().min(1).max(128),
  model:       z.string().min(1).max(128),
  serial:      z.string().min(1).max(64),
  description: z.string().optional(),
});

export const updateRobotSchema = z.object({
  name:        z.string().min(1).max(128).optional(),
  status:      z.enum(["ONLINE", "OFFLINE", "FAULT", "IDLE"]).optional(),
  description: z.string().optional(),
});

// ── Sensors ───────────────────────────────────────────────────────────────────
export const createSensorSchema = z.object({
  name:   z.string().min(1).max(128),
  type:   z.enum(["JOINT_ANGLE", "MOTOR_CURRENT", "TEMPERATURE", "VELOCITY",
                   "FORCE_TORQUE", "BATTERY_VOLTAGE", "IMU_ACCEL"]),
  unit:   z.string().max(32),
  minVal: z.number().optional(),
  maxVal: z.number().optional(),
});

// ── Readings ──────────────────────────────────────────────────────────────────
export const readingItemSchema = z.object({
  sensorId:  z.number().int().positive(),
  value:     z.number(),
  timestamp: z.string().datetime().optional(),
});

export const batchReadingsSchema = z.object({
  readings: z.array(readingItemSchema).min(1).max(1000),
});

export type RegisterInput    = z.infer<typeof registerSchema>;
export type LoginInput       = z.infer<typeof loginSchema>;
export type CreateRobotInput = z.infer<typeof createRobotSchema>;
export type UpdateRobotInput = z.infer<typeof updateRobotSchema>;
export type CreateSensorInput= z.infer<typeof createSensorSchema>;
export type BatchReadingsInput = z.infer<typeof batchReadingsSchema>;
