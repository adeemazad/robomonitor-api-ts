// src/routes/robots.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../utils/db.js";
import { createRobotSchema, updateRobotSchema } from "../middleware/schemas.js";

export async function robotRoutes(app: FastifyInstance): Promise<void> {

  const auth = { preHandler: [app.authenticate] };

  // Helper — fetch robot and verify ownership
  async function ownedRobot(robotId: number, userId: number) {
    return prisma.robot.findFirst({
      where: { id: robotId, ownerId: userId },
      include: { sensors: true },
    });
  }

  // ── POST /robots ──────────────────────────────────────────────────────────
  app.post("/robots", auth, async (req, reply) => {
    const body = createRobotSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Validation error", details: body.error.format() });

    const existing = await prisma.robot.findUnique({ where: { serial: body.data.serial } });
    if (existing) return reply.code(409).send({ error: "Serial number already registered" });

    const robot = await prisma.robot.create({
      data: { ...body.data, ownerId: (req.user as any).sub },
    });
    return reply.code(201).send(robot);
  });

  // ── GET /robots ───────────────────────────────────────────────────────────
  app.get("/robots", auth, async (req) => {
    return prisma.robot.findMany({
      where: { ownerId: (req.user as any).sub },
      include: { _count: { select: { sensors: true, alerts: true } } } as any,
      orderBy: { createdAt: "desc" },
    });
  });

  // ── GET /robots/:id ───────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/robots/:id", auth, async (req, reply) => {
    const robot = await ownedRobot(Number(req.params.id), (req.user as any).sub);
    if (!robot) return reply.code(404).send({ error: "Robot not found" });
    return robot;
  });

  // ── PATCH /robots/:id ─────────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>("/robots/:id", auth, async (req, reply) => {
    const body = updateRobotSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Validation error", details: body.error.format() });

    const robot = await ownedRobot(Number(req.params.id), (req.user as any).sub);
    if (!robot) return reply.code(404).send({ error: "Robot not found" });

    return prisma.robot.update({ where: { id: robot.id }, data: body.data });
  });

  // ── DELETE /robots/:id ────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/robots/:id", auth, async (req, reply) => {
    const robot = await ownedRobot(Number(req.params.id), (req.user as any).sub);
    if (!robot) return reply.code(404).send({ error: "Robot not found" });

    await prisma.robot.delete({ where: { id: robot.id } });
    return reply.code(204).send();
  });

  // ── GET /robots/:id/stats ─────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/robots/:id/stats", auth, async (req, reply) => {
    const robotId = Number(req.params.id);
    const robot = await ownedRobot(robotId, (req.user as any).sub);
    if (!robot) return reply.code(404).send({ error: "Robot not found" });

    const sensorIds = robot.sensors.map((s: { id: number }) => s.id);

    if (sensorIds.length === 0) {
      return {
        robotId, totalReadings: 0, anomalyCount: 0,
        anomalyRate: 0, activeAlerts: 0, lastReading: null,
        sensorCount: 0,
      };
    }

    const [totalReadings, anomalyCount, lastReadingRow, activeAlerts] = await Promise.all([
      prisma.reading.count({ where: { sensorId: { in: sensorIds } } }),
      prisma.reading.count({ where: { sensorId: { in: sensorIds }, isAnomaly: true } }),
      prisma.reading.findFirst({
        where: { sensorId: { in: sensorIds } },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      prisma.alert.count({ where: { robotId, acknowledged: false } }),
    ]);

    return {
      robotId,
      totalReadings,
      anomalyCount,
      anomalyRate: totalReadings > 0 ? Math.round((anomalyCount / totalReadings) * 10000) / 10000 : 0,
      activeAlerts,
      lastReading: lastReadingRow?.timestamp ?? null,
      sensorCount: sensorIds.length,
    };
  });

  // ── POST /robots/:id/sensors ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/robots/:id/sensors", auth, async (req, reply) => {
    const { createSensorSchema } = await import("../middleware/schemas.js");
    const body = createSensorSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Validation error", details: body.error.format() });

    const robot = await ownedRobot(Number(req.params.id), (req.user as any).sub);
    if (!robot) return reply.code(404).send({ error: "Robot not found" });

    const sensor = await prisma.sensor.create({
      data: { ...body.data, robotId: robot.id },
    });
    return reply.code(201).send(sensor);
  });
}
