// tests/api.test.ts
// Integration tests using Fastify's inject() — no real HTTP needed.
// Uses an in-memory SQLite database seeded fresh per suite.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/utils/db.js";
import { execSync } from "child_process";

let app: FastifyInstance;
let token: string;
let robotId: number;
let sensorId: number;

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env.DATABASE_URL = "file:./test.db";
  process.env.JWT_SECRET   = "test-secret-key-at-least-32-chars-long!";
  process.env.NODE_ENV     = "test";

  // Push schema to test DB
  execSync("npx prisma db push --force-reset --skip-generate", {
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "pipe",
  });

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  execSync("rm -f ./test.db", { stdio: "pipe" });
});

// ── Health ─────────────────────────────────────────────────────────────────────
describe("Health", () => {
  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("RoboMonitor");
  });
});

// ── Auth ───────────────────────────────────────────────────────────────────────
describe("Auth", () => {
  it("POST /auth/register creates a user", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username: "testuser", email: "test@example.com", password: "SecurePass123" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().username).toBe("testuser");
  });

  it("POST /auth/register rejects duplicate username", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { username: "testuser", email: "other@example.com", password: "SecurePass123" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /auth/login returns access token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "testuser", password: "SecurePass123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeDefined();
    token = body.accessToken;
  });

  it("POST /auth/login rejects wrong password", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "testuser", password: "wrongpassword" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /auth/me returns current user", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe("testuser");
  });

  it("GET /auth/me without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
  });
});

// ── Robots ─────────────────────────────────────────────────────────────────────
describe("Robots", () => {
  it("POST /robots creates a robot", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/robots",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "UR5e", model: "Universal Robots UR5e", serial: "SN-001" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.serial).toBe("SN-001");
    robotId = body.id;
  });

  it("POST /robots rejects duplicate serial", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/robots",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Dup", model: "M", serial: "SN-001" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("GET /robots returns list", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/robots",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /robots/:id returns robot", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/v1/robots/${robotId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(robotId);
  });

  it("GET /robots/99999 returns 404", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/robots/99999",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /robots/:id/sensors creates a sensor", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/v1/robots/${robotId}/sensors`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "joint1_angle", type: "JOINT_ANGLE", unit: "deg", minVal: -180, maxVal: 180 },
    });
    expect(res.statusCode).toBe(201);
    sensorId = res.json().id;
  });
});

// ── Telemetry ──────────────────────────────────────────────────────────────────
describe("Telemetry", () => {
  it("POST /robots/:id/readings ingests batch", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/v1/robots/${robotId}/readings`,
      headers: { authorization: `Bearer ${token}` },
      payload: { readings: [{ sensorId, value: 45.2 }, { sensorId, value: 46.1 }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.inserted).toBe(2);
  });

  it("GET /robots/:id/readings returns history", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/v1/robots/${robotId}/readings?limit=10`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json().length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid sensor ID", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/v1/robots/${robotId}/readings`,
      headers: { authorization: `Bearer ${token}` },
      payload: { readings: [{ sensorId: 99999, value: 1.0 }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("GET /robots/:id/stats returns metrics", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/v1/robots/${robotId}/stats`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalReadings).toBeGreaterThanOrEqual(2);
    expect(typeof body.anomalyRate).toBe("number");
    expect(body.sensorCount).toBe(1);
  });
});

// ── Anomaly detection unit tests ───────────────────────────────────────────────
describe("AnomalyDetector", () => {
  it("flags a clear outlier after warm-up", async () => {
    const { AnomalyDetector } = await import("../src/services/anomaly.js");
    const det = new AnomalyDetector();

    // Warm up with normal N(50, 2) data
    for (let i = 0; i < 80; i++) {
      det.detect(99, 50 + (Math.random() - 0.5) * 4);
    }
    // 10σ outlier — must be flagged
    const result = det.detect(99, 50 + 10 * 2);
    expect(result.isAnomaly).toBe(true);
    expect(result.anomalyScore).toBeGreaterThan(3);
    expect(result.detectorsFired.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag a normal reading", async () => {
    const { AnomalyDetector } = await import("../src/services/anomaly.js");
    const det = new AnomalyDetector();
    for (let i = 0; i < 60; i++) det.detect(100, 100 + (Math.random() - 0.5) * 10);
    const result = det.detect(100, 100.5);
    expect(result.isAnomaly).toBe(false);
  });

  it("detects slow drift via CUSUM", async () => {
    const { AnomalyDetector } = await import("../src/services/anomaly.js");
    const det = new AnomalyDetector();
    for (let i = 0; i < 40; i++) det.detect(101, 20 + Math.random() * 0.5);

    let detected = false;
    for (let i = 0; i < 50; i++) {
      const result = det.detect(101, 20 + i * 0.4);  // slow upward drift
      if (result.isAnomaly) { detected = true; break; }
    }
    expect(detected).toBe(true);
  });
});

// ── Simulator unit tests ───────────────────────────────────────────────────────
describe("RobotSimulator", () => {
  it("produces readings for all joints and battery", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const sim = new RobotSimulator(0);
    const readings = sim.tick(0.1);
    expect(readings.length).toBeGreaterThan(0);

    const names = readings.map((r) => r.sensorName);
    expect(names).toContain("battery_voltage");
    expect(names.some((n) => n.includes("angle"))).toBe(true);
  });

  it("injects faults stochastically", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const sim = new RobotSimulator(42);
    (sim as any).faultProb = 0.99;   // force faults
    let gotFault = false;
    for (let i = 0; i < 5; i++) {
      sim.tick(0.1);
      if ((sim as any).joints.some((j: any) => j.faultActive)) {
        gotFault = true; break;
      }
    }
    expect(gotFault).toBe(true);
  });
});
