// src/routes/ws.ts
import { FastifyInstance } from "fastify";
import { wsManager } from "../services/wsManager.js";
import { streamReadings } from "../services/simulator.js";
import { getDetector } from "../services/anomaly.js";
import { config } from "../utils/config.js";

export async function wsRoutes(app: FastifyInstance): Promise<void> {

  // ── ws://host/ws/robots/:id — subscribe to a specific robot ──────────────
  // Receives readings pushed by POST /robots/:id/readings
  app.get<{ Params: { id: string } }>("/ws/robots/:id", { websocket: true }, (socket, req) => {
    const robotId = Number(req.params.id);
    wsManager.register(socket, robotId);
    app.log.info({ robotId, connections: wsManager.connectionCount }, "ws_robot_subscribe");

    // Heartbeat
    const hb = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: "heartbeat", robotId, timestamp: new Date().toISOString() }));
      } catch { clearInterval(hb); }
    }, config.WS_HEARTBEAT_MS);

    socket.on("close", () => clearInterval(hb));
  });

  // ── ws://host/ws/demo — self-contained simulator demo ────────────────────
  // No auth, no database — streams simulated sensor data with live anomaly detection.
  // Perfect for recruiters to try instantly: wscat -c ws://your-url/ws/demo
  app.get("/ws/demo", { websocket: true }, async (socket) => {
    wsManager.register(socket);
    app.log.info({ connections: wsManager.connectionCount }, "ws_demo_connect");

    const detector  = getDetector();
    const sensorMap = new Map<string, number>();

    try {
      for await (const batch of streamReadings()) {
        if (socket.readyState !== 1) break;

        for (const reading of batch) {
          // Assign stable fake sensor IDs
          if (!sensorMap.has(reading.sensorName)) {
            sensorMap.set(reading.sensorName, sensorMap.size + 1);
          }
          const sensorId = sensorMap.get(reading.sensorName)!;
          const detection = detector.detect(sensorId, reading.value);

          socket.send(JSON.stringify({
            type:         detection.isAnomaly ? "alert" : "reading",
            robotId:      999,
            sensorId,
            sensorName:   reading.sensorName,
            sensorType:   reading.sensorType,
            value:        reading.value,
            unit:         reading.unit,
            timestamp:    reading.timestamp.toISOString(),
            isAnomaly:    detection.isAnomaly,
            anomalyScore: detection.anomalyScore,
            detectors:    detection.detectorsFired,
          }));
        }
      }
    } catch (err) {
      app.log.info("ws_demo_disconnect");
    }
  });
}
