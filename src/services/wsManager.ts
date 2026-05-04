// src/services/wsManager.ts
// Thread-safe WebSocket broadcast manager.
// Supports per-robot subscriptions and global broadcast.

import type { WebSocket } from "@fastify/websocket";

type SocketSet = Set<WebSocket>;

class WsManager {
  private byRobot = new Map<number, SocketSet>();
  private all: SocketSet = new Set();

  register(ws: WebSocket, robotId?: number): void {
    this.all.add(ws);
    if (robotId !== undefined) {
      if (!this.byRobot.has(robotId)) this.byRobot.set(robotId, new Set());
      this.byRobot.get(robotId)!.add(ws);
    }
    ws.on("close", () => this.remove(ws, robotId));
    ws.on("error", () => this.remove(ws, robotId));
  }

  remove(ws: WebSocket, robotId?: number): void {
    this.all.delete(ws);
    if (robotId !== undefined) this.byRobot.get(robotId)?.delete(ws);
    else for (const s of this.byRobot.values()) s.delete(ws);
  }

  broadcastToRobot(robotId: number, payload: string): void {
    const targets = this.byRobot.get(robotId);
    if (!targets) return;
    for (const ws of targets) this.safeSend(ws, payload);
  }

  broadcastAll(payload: string): void {
    for (const ws of this.all) this.safeSend(ws, payload);
  }

  get connectionCount(): number { return this.all.size; }

  private safeSend(ws: WebSocket, payload: string): void {
    try {
      if (ws.readyState === 1 /* OPEN */) ws.send(payload);
    } catch {
      this.remove(ws);
    }
  }
}

export const wsManager = new WsManager();
