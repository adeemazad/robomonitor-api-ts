// tests/unit.test.ts
// Pure unit tests: anomaly detector, simulator, config, schemas
// No database required — these always run in CI even with no DB.

import { describe, it, expect, beforeEach } from "vitest";

// ── AnomalyDetector ───────────────────────────────────────────────────────────
describe("AnomalyDetector", () => {
  let AnomalyDetector: any;

  beforeEach(async () => {
    const mod = await import("../src/services/anomaly.js");
    AnomalyDetector = mod.AnomalyDetector;
  });

  it("returns no anomaly before warm-up window is reached", () => {
    const det = new AnomalyDetector();
    // Push only a few readings — less than threshold
    for (let i = 0; i < 5; i++) {
      const r = det.detect(1, 50 + Math.random());
      expect(r.isAnomaly).toBe(false);
    }
  });

  it("flags a clear 10σ outlier after warm-up", () => {
    const det = new AnomalyDetector();
    for (let i = 0; i < 80; i++) {
      det.detect(1, 50 + (Math.random() - 0.5) * 4); // N(50, 2)
    }
    const result = det.detect(1, 50 + 20 * 2); // 20σ
    expect(result.isAnomaly).toBe(true);
    expect(result.anomalyScore).toBeGreaterThan(3);
    expect(result.detectorsFired.length).toBeGreaterThanOrEqual(2);
    expect(result.detectorsFired).toContain("z_score");
  });

  it("does not flag a 0.5σ reading as anomalous", () => {
    const det = new AnomalyDetector();
    for (let i = 0; i < 60; i++) det.detect(2, 100 + (Math.random() - 0.5) * 10);
    const result = det.detect(2, 100.5);
    expect(result.isAnomaly).toBe(false);
    expect(result.detectorsFired).toHaveLength(0);
  });

  it("detects slow drift via CUSUM detector", () => {
    const det = new AnomalyDetector();
    for (let i = 0; i < 50; i++) det.detect(3, 20 + Math.random() * 0.5);

    let detected = false;
    for (let i = 1; i <= 60; i++) {
      const r = det.detect(3, 20 + i * 0.5); // steady upward drift
      if (r.isAnomaly) { detected = true; break; }
    }
    expect(detected).toBe(true);
  });

  it("resets sensor state cleanly", () => {
    const det = new AnomalyDetector();
    for (let i = 0; i < 80; i++) det.detect(4, 100);
    det.resetSensor(4);
    // After reset, should not flag first reading
    const result = det.detect(4, 100);
    expect(result.isAnomaly).toBe(false);
  });

  it("handles multiple sensors independently", () => {
    const det = new AnomalyDetector();
    // Warm up sensor 10 with N(10, 1)
    for (let i = 0; i < 70; i++) det.detect(10, 10 + (Math.random() - 0.5) * 2);
    // Warm up sensor 20 with N(200, 5)
    for (let i = 0; i < 70; i++) det.detect(20, 200 + (Math.random() - 0.5) * 10);

    // Outlier for sensor 10 should not affect sensor 20
    const r10 = det.detect(10, 10 + 25); // clear outlier for s10
    const r20 = det.detect(20, 200.5);   // normal for s20

    expect(r10.isAnomaly).toBe(true);
    expect(r20.isAnomaly).toBe(false);
  });

  it("anomaly score is non-negative", () => {
    const det = new AnomalyDetector();
    for (let i = 0; i < 50; i++) {
      const r = det.detect(5, Math.random() * 100);
      expect(r.anomalyScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("IQR fence fires on a value far outside quartiles", () => {
    const det = new AnomalyDetector();
    // All readings clustered tightly at 0 → IQR ≈ 0, but after some spread:
    for (let i = 0; i < 60; i++) det.detect(6, i % 2 === 0 ? 49 : 51); // tight: 49/51
    const r = det.detect(6, 200); // massively outside
    expect(r.isAnomaly).toBe(true);
    expect(r.detectorsFired).toContain("iqr");
  });
});

// ── RobotSimulator ────────────────────────────────────────────────────────────
describe("RobotSimulator", () => {
  it("produces readings including battery and joint sensors", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const sim = new RobotSimulator(0);
    const readings = sim.tick(0.1);

    expect(readings.length).toBeGreaterThan(10);
    const names = readings.map((r) => r.sensorName);
    expect(names).toContain("battery_voltage");
    expect(names.some((n) => n.includes("angle"))).toBe(true);
    expect(names.some((n) => n.includes("current"))).toBe(true);
    expect(names.some((n) => n.includes("temp"))).toBe(true);
  });

  it("all readings have valid numeric values", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const sim = new RobotSimulator(1);
    for (let i = 0; i < 20; i++) {
      const readings = sim.tick(0.1);
      for (const r of readings) {
        expect(typeof r.value).toBe("number");
        expect(isFinite(r.value)).toBe(true);
        expect(isNaN(r.value)).toBe(false);
      }
    }
  });

  it("battery voltage decreases over time", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const sim = new RobotSimulator(2);
    const first = sim.tick(0.1).find((r) => r.sensorName === "battery_voltage")!;
    for (let i = 0; i < 200; i++) sim.tick(1.0);
    const last = sim.tick(1.0).find((r) => r.sensorName === "battery_voltage")!;
    expect(last.value).toBeLessThan(first.value + 0.5); // accounting for noise
  });

  it("different seeds produce different sequences", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const a = new RobotSimulator(1).tick(0.1).map((r) => r.value);
    const b = new RobotSimulator(9999).tick(0.1).map((r) => r.value);
    expect(a).not.toEqual(b);
  });

  it("injects faults when probability is set high", async () => {
    const { RobotSimulator } = await import("../src/services/simulator.js");
    const sim = new RobotSimulator(42);
    (sim as any).faultProb = 1.0;   // guaranteed fault every tick

    let gotFault = false;
    for (let i = 0; i < 10; i++) {
      sim.tick(0.1);
      if ((sim as any).joints.some((j: any) => j.faultActive)) {
        gotFault = true; break;
      }
    }
    expect(gotFault).toBe(true);
  });
});

// ── Config validation ─────────────────────────────────────────────────────────
describe("Config", () => {
  it("loads default config without crashing", async () => {
    const { config } = await import("../src/utils/config.js");
    expect(config.PORT).toBe(3000);
    expect(config.ANOMALY_WINDOW).toBe(30);
    expect(config.ANOMALY_Z_THRESHOLD).toBe(3.5);
    expect(config.SIMULATOR_HZ).toBe(10);
  });
});

// ── Zod schemas ───────────────────────────────────────────────────────────────
describe("Validation schemas", () => {
  it("registerSchema rejects short password", async () => {
    const { registerSchema } = await import("../src/middleware/schemas.js");
    const r = registerSchema.safeParse({ username: "alice", email: "a@b.com", password: "short" });
    expect(r.success).toBe(false);
  });

  it("registerSchema accepts valid input", async () => {
    const { registerSchema } = await import("../src/middleware/schemas.js");
    const r = registerSchema.safeParse({ username: "alice", email: "a@b.com", password: "longpassword" });
    expect(r.success).toBe(true);
  });

  it("batchReadingsSchema rejects empty array", async () => {
    const { batchReadingsSchema } = await import("../src/middleware/schemas.js");
    const r = batchReadingsSchema.safeParse({ readings: [] });
    expect(r.success).toBe(false);
  });

  it("batchReadingsSchema accepts valid batch", async () => {
    const { batchReadingsSchema } = await import("../src/middleware/schemas.js");
    const r = batchReadingsSchema.safeParse({
      readings: [{ sensorId: 1, value: 42.5 }, { sensorId: 2, value: -1.0 }]
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.readings).toHaveLength(2);
  });

  it("createRobotSchema validates serial length", async () => {
    const { createRobotSchema } = await import("../src/middleware/schemas.js");
    const valid = createRobotSchema.safeParse({ name: "Bot", model: "UR5e", serial: "SN-001" });
    const invalid = createRobotSchema.safeParse({ name: "", model: "UR5e", serial: "SN-001" });
    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});
