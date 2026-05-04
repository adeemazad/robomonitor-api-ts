// src/routes/telemetry.ts
// Sensor reading ingestion → anomaly detection → alert generation → WebSocket push
import { FastifyInstance } from "fastify";
import { prisma } from "../utils/db.js";
import { batchReadingsSchema } from "../middleware/schemas.js";
import { getDetector } from "../services/anomaly.js";
import { wsManager } from "../services/wsManager.js";

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  // ── POST /robots/:id/readings — batch ingest ──────────────────────────────
  app.post<{ Params: { id: string } }>("/robots/:id/readings", auth, async (req, reply) => {
    const robotId = Number(req.params.id);

    const body = batchReadingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Validation error", details: body.error.format() });

    // Verify ownership
    const robot = await prisma.robot.findFirst({ where: { id: robotId, ownerId: (req.user as any).sub } });
    if (!robot) return reply.code(404).send({ error: "Robot not found" });

    // Verify sensor IDs all belong to this robot
    const sensorIds = [...new Set(body.data.readings.map((r) => r.sensorId))];
    const validSensors = await prisma.sensor.findMany({
      where: { id: { in: sensorIds }, robotId },
      select: { id: true, name: true },
    });
    const validIds = new Set(validSensors.map((s: any) => s.id));
    const invalid = sensorIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return reply.code(422).send({ error: `Sensor IDs not on this robot: ${invalid.join(", ")}` });
    }

    const detector  = getDetector();
    const sensorMap = new Map(validSensors.map((s: any) => [s.id, s.name]));
    const results   = [];
    const alertsToCreate = [];

    for (const item of body.data.readings) {
      const detection = detector.detect(item.sensorId, item.value);
      const ts = item.timestamp ? new Date(item.timestamp) : new Date();

      results.push({
        sensorId:     item.sensorId,
        value:        item.value,
        timestamp:    ts,
        isAnomaly:    detection.isAnomaly,
        anomalyScore: detection.anomalyScore,
      });

      if (detection.isAnomaly) {
        const severity = detection.anomalyScore > 5 ? "CRITICAL" : "WARNING";
        alertsToCreate.push({
          robotId,
          sensorId:  item.sensorId,
          severity:  severity as "CRITICAL" | "WARNING",
          message:   `Anomaly on ${sensorMap.get(item.sensorId)}: value=${item.value.toFixed(3)}, score=${detection.anomalyScore} [${detection.detectorsFired.join(", ")}]`,
          value:     item.value,
        });

        // WebSocket alert push
        const wsPayload = JSON.stringify({
          type:     "alert",
          robotId,
          sensorId: item.sensorId,
          severity,
          message:  alertsToCreate.at(-1)!.message,
          timestamp: ts.toISOString(),
        });
        wsManager.broadcastToRobot(robotId, wsPayload);
        wsManager.broadcastAll(wsPayload);
      }

      // WebSocket reading push
      wsManager.broadcastToRobot(robotId, JSON.stringify({
        type:         "reading",
        robotId,
        sensorId:     item.sensorId,
        sensorName:   sensorMap.get(item.sensorId),
        value:        item.value,
        timestamp:    ts.toISOString(),
        isAnomaly:    detection.isAnomaly,
        anomalyScore: detection.anomalyScore,
      }));
    }

    // Batch-insert all readings + alerts in parallel
    const [created] = await Promise.all([
      prisma.reading.createMany({ data: results }),
      alertsToCreate.length > 0 ? prisma.alert.createMany({ data: alertsToCreate }) : Promise.resolve(),
      prisma.robot.update({ where: { id: robotId }, data: { lastSeen: new Date() } }),
    ]);

    return reply.code(201).send({ inserted: created.count, anomalies: alertsToCreate.length });
  });

  // ── GET /robots/:id/readings — paginated history ──────────────────────────
  app.get<{ Params: { id: string }; Querystring: { sensorId?: string; anomaliesOnly?: string; limit?: string; offset?: string } }>(
    "/robots/:id/readings", auth, async (req, reply) => {
      const robotId = Number(req.params.id);
      const robot = await prisma.robot.findFirst({ where: { id: robotId, ownerId: (req.user as any).sub } });
      if (!robot) return reply.code(404).send({ error: "Robot not found" });

      const { sensorId, anomaliesOnly, limit = "100", offset = "0" } = req.query;
      const sensorSubq = (await prisma.sensor.findMany({
        where: { robotId },
        select: { id: true },
      })).map((s: any) => s.id);

      return prisma.reading.findMany({
        where: {
          sensorId:  { in: sensorId ? [Number(sensorId)] : sensorSubq },
          isAnomaly: anomaliesOnly === "true" ? true : undefined,
        },
        orderBy: { timestamp: "desc" },
        take:   Math.min(Number(limit), 10_000),
        skip:   Number(offset),
        include: { sensor: { select: { name: true, type: true, unit: true } } },
      });
    }
  );

  // ── GET /robots/:id/alerts ────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { unacknowledgedOnly?: string; limit?: string } }>(
    "/robots/:id/alerts", auth, async (req, reply) => {
      const robotId = Number(req.params.id);
      const robot = await prisma.robot.findFirst({ where: { id: robotId, ownerId: (req.user as any).sub } });
      if (!robot) return reply.code(404).send({ error: "Robot not found" });

      return prisma.alert.findMany({
        where: {
          robotId,
          acknowledged: req.query.unacknowledgedOnly === "true" ? false : undefined,
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(req.query.limit ?? "50"), 500),
      });
    }
  );

  // ── POST /robots/:rid/alerts/:aid/acknowledge ─────────────────────────────
  app.post<{ Params: { id: string; alertId: string } }>(
    "/robots/:id/alerts/:alertId/acknowledge", auth, async (req, reply) => {
      const robotId = Number(req.params.id);
      const alertId = Number(req.params.alertId);

      const robot = await prisma.robot.findFirst({ where: { id: robotId, ownerId: (req.user as any).sub } });
      if (!robot) return reply.code(404).send({ error: "Robot not found" });

      const alert = await prisma.alert.findFirst({ where: { id: alertId, robotId } });
      if (!alert) return reply.code(404).send({ error: "Alert not found" });

      return prisma.alert.update({ where: { id: alertId }, data: { acknowledged: true } });
    }
  );
}
