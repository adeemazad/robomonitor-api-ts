// scripts/seed.ts
// Populates the database with a demo user, robot, sensors, and 500 readings.
// Run: npm run db:seed

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { RobotSimulator } from "../src/services/simulator.js";
import { AnomalyDetector } from "../src/services/anomaly.js";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...\n");

  // ── User ──────────────────────────────────────────────────────────────────
  const user = await prisma.user.upsert({
    where: { username: "demo" },
    update: {},
    create: {
      username: "demo",
      email: "demo@robomonitor.dev",
      hashedPassword: await bcrypt.hash("demo1234", 12),
    },
  });
  console.log(`✓ User: ${user.username} (password: demo1234)`);

  // ── Robot ─────────────────────────────────────────────────────────────────
  const robot = await prisma.robot.upsert({
    where: { serial: "SEED-UR5E-001" },
    update: { status: "ONLINE" },
    create: {
      name: "Demo UR5e",
      model: "Universal Robots UR5e",
      serial: "SEED-UR5E-001",
      description: "6-DOF collaborative robot arm — seeded demo data",
      status: "ONLINE",
      ownerId: user.id,
    },
  });
  console.log(`✓ Robot: ${robot.name} (id=${robot.id})`);

  // ── Sensors ───────────────────────────────────────────────────────────────
  const sensorDefs = [
    { name: "shoulder_pan_angle",   type: "JOINT_ANGLE",    unit: "deg", minVal: -180, maxVal: 180 },
    { name: "shoulder_pan_current", type: "MOTOR_CURRENT",  unit: "A",   minVal: 0,    maxVal: 10  },
    { name: "shoulder_pan_temp",    type: "TEMPERATURE",    unit: "°C",  minVal: 0,    maxVal: 80  },
    { name: "elbow_angle",          type: "JOINT_ANGLE",    unit: "deg", minVal: -180, maxVal: 180 },
    { name: "elbow_current",        type: "MOTOR_CURRENT",  unit: "A",   minVal: 0,    maxVal: 10  },
    { name: "battery_voltage",      type: "BATTERY_VOLTAGE",unit: "V",   minVal: 40,   maxVal: 54  },
  ] as const;

  const sensors = await Promise.all(
    sensorDefs.map((def) =>
      prisma.sensor.upsert({
        where: { id: 0 },   // force create
        update: {},
        create: { ...def, robotId: robot.id },
      }).catch(() =>
        prisma.sensor.findFirst({ where: { name: def.name, robotId: robot.id } })
      )
    )
  );

  // Re-fetch to get real IDs after upsert
  const actualSensors = await prisma.sensor.findMany({ where: { robotId: robot.id } });
  console.log(`✓ Sensors: ${actualSensors.length} created`);

  // ── Readings (500 ticks) ──────────────────────────────────────────────────
  const sim = new RobotSimulator(42);
  const det = new AnomalyDetector();
  const sensorNameToId = new Map(actualSensors.map((s) => [s.name, s.id]));

  const readingBatch: { sensorId: number; value: number; isAnomaly: boolean; anomalyScore: number | null; timestamp: Date }[] = [];
  const alertBatch: { robotId: number; sensorId: number; severity: "WARNING" | "CRITICAL"; message: string; value: number }[] = [];

  const startTime = new Date(Date.now() - 500 * 100);  // 500 ticks, 100ms apart

  for (let tick = 0; tick < 500; tick++) {
    const readings = sim.tick(0.1);
    const ts = new Date(startTime.getTime() + tick * 100);

    for (const reading of readings) {
      const sensorId = sensorNameToId.get(reading.sensorName);
      if (!sensorId) continue;

      const det_result = det.detect(sensorId, reading.value);
      readingBatch.push({
        sensorId,
        value: reading.value,
        isAnomaly: det_result.isAnomaly,
        anomalyScore: det_result.isAnomaly ? det_result.anomalyScore : null,
        timestamp: ts,
      });

      if (det_result.isAnomaly) {
        alertBatch.push({
          robotId: robot.id,
          sensorId,
          severity: det_result.anomalyScore > 5 ? "CRITICAL" : "WARNING",
          message: `Seeded anomaly on ${reading.sensorName}: ${reading.value.toFixed(3)} (score=${det_result.anomalyScore})`,
          value: reading.value,
        });
      }
    }
  }

  await prisma.reading.createMany({ data: readingBatch });
  if (alertBatch.length > 0) await prisma.alert.createMany({ data: alertBatch });

  const anomalyCount = readingBatch.filter((r) => r.isAnomaly).length;
  console.log(`✓ Readings: ${readingBatch.length} inserted (${anomalyCount} anomalies, ${alertBatch.length} alerts)\n`);

  console.log("─".repeat(50));
  console.log("Demo credentials:");
  console.log("  Username : demo");
  console.log("  Password : demo1234");
  console.log(`  Robot ID : ${robot.id}`);
  console.log("\nAPI docs: http://localhost:3000/docs");
  console.log("WS demo : wscat -c ws://localhost:3000/ws/demo");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
