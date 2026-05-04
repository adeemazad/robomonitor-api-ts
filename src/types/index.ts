// src/types/index.ts

export interface JwtPayload {
  sub: number;   // user id
  username: string;
  iat?: number;
  exp?: number;
}

export interface DetectionResult {
  isAnomaly: boolean;
  anomalyScore: number;
  detectorsFired: string[];
}

export interface SimulatedReading {
  sensorName: string;
  sensorType: string;
  value: number;
  unit: string;
  timestamp: Date;
}

export interface WsMessage {
  type: "reading" | "alert" | "heartbeat" | "ack";
  robotId: number;
  timestamp: string;
  [key: string]: unknown;
}

export interface RobotStats {
  robotId: number;
  totalReadings: number;
  anomalyCount: number;
  anomalyRate: number;
  activeAlerts: number;
  lastReading: Date | null;
  sensorCount: number;
}
