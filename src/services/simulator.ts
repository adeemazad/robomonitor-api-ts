// src/services/simulator.ts
// Simulates a 6-DOF robot arm sensor stream.
// Used by the /ws/demo endpoint and the seed script.
//
// Models:
//   • Joint angles — sinusoidal trajectories with random phase/frequency
//   • Motor currents — load-proportional with thermal drift
//   • Joint temperatures — first-order thermal model (R*C)
//   • Battery voltage — slow discharge + noise
//   • Fault injection — spike | drift | oscillation (stochastic)

import { SimulatedReading } from "../types/index.js";
import { config } from "../utils/config.js";

const TWO_PI = 2 * Math.PI;

// Seeded PRNG (mulberry32) — reproducible output for demos
function makePrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number, mu = 0, sigma = 1): number {
  // Box–Muller transform
  const u1 = Math.max(1e-10, rng());
  const u2 = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2);
}

interface JointState {
  name: string;
  phase: number;
  freq: number;       // Hz
  amplitude: number;  // degrees
  currentBase: number; // A
  temp: number;       // °C
  faultActive: boolean;
  faultType: "none" | "spike" | "drift" | "oscillation";
  faultAge: number;
}

const JOINT_NAMES = [
  "shoulder_pan", "shoulder_lift", "elbow",
  "wrist1", "wrist2", "wrist3",
];

export class RobotSimulator {
  private rng: () => number;
  private t = 0;
  private joints: JointState[];
  private batteryV = 48.0;
  private readonly faultProb = 0.003;

  constructor(seed = 42) {
    this.rng = makePrng(seed);
    this.joints = JOINT_NAMES.map((name) => ({
      name,
      phase:       this.rng() * TWO_PI,
      freq:        0.05 + this.rng() * 0.15,
      amplitude:   30 + this.rng() * 30,
      currentBase: 1.5 + this.rng() * 2.0,
      temp:        22 + this.rng() * 13,
      faultActive: false,
      faultType:   "none",
      faultAge:    0,
    }));
  }

  tick(dt = 0.1): SimulatedReading[] {
    this.t += dt;
    const readings: SimulatedReading[] = [];
    const now = new Date();

    for (const j of this.joints) {
      // Inject fault
      if (!j.faultActive && this.rng() < this.faultProb) {
        j.faultActive = true;
        const r = this.rng();
        j.faultType = r < 0.33 ? "spike" : r < 0.66 ? "drift" : "oscillation";
        j.faultAge = 0;
      }
      j.faultAge++;

      // Clear transient faults
      if (j.faultActive && j.faultType === "spike" && j.faultAge > 1) {
        j.faultActive = false; j.faultType = "none";
      }
      if (j.faultActive && j.faultAge > 100) {
        j.faultActive = false; j.faultType = "none";
      }

      // Joint angle
      let angle = j.amplitude * Math.sin(TWO_PI * j.freq * this.t + j.phase);
      if (j.faultActive) {
        if      (j.faultType === "drift")       angle += j.faultAge * 0.3;
        else if (j.faultType === "oscillation") angle += 15 * Math.sin(TWO_PI * 5 * this.t);
        else if (j.faultType === "spike")       angle += (this.rng() > 0.5 ? 1 : -1) * (50 + this.rng() * 30);
      }
      angle += gauss(this.rng, 0, 0.2);

      // Motor current (proportional to angular velocity)
      const angVel = j.amplitude * j.freq * TWO_PI * Math.cos(TWO_PI * j.freq * this.t + j.phase);
      let current = j.currentBase + Math.abs(angVel) * 0.02 + gauss(this.rng, 0, 0.05);
      if (j.faultActive && j.faultType !== "spike") current *= 1.4;

      // Temperature (first-order thermal)
      const heatIn = current ** 2 * 0.1;
      j.temp += (heatIn - (j.temp - 22) * 0.01) * dt + gauss(this.rng, 0, 0.02);

      const r = (v: number) => Math.round(v * 1000) / 1000;
      readings.push(
        { sensorName: `${j.name}_angle`,   sensorType: "JOINT_ANGLE",   value: r(angle),   unit: "deg", timestamp: now },
        { sensorName: `${j.name}_current`, sensorType: "MOTOR_CURRENT", value: r(current), unit: "A",   timestamp: now },
        { sensorName: `${j.name}_temp`,    sensorType: "TEMPERATURE",   value: r(j.temp),  unit: "°C",  timestamp: now },
      );
    }

    // Battery
    this.batteryV -= 0.00005 * dt;
    readings.push({
      sensorName: "battery_voltage",
      sensorType: "BATTERY_VOLTAGE",
      value: Math.round((this.batteryV + gauss(this.rng, 0, 0.02)) * 1000) / 1000,
      unit: "V",
      timestamp: new Date(),
    });

    return readings;
  }
}

// Async generator for WebSocket streaming
export async function* streamReadings(hz = config.SIMULATOR_HZ): AsyncGenerator<SimulatedReading[]> {
  const sim = new RobotSimulator();
  const dt  = 1 / hz;
  while (true) {
    yield sim.tick(dt);
    await new Promise((r) => setTimeout(r, dt * 1000));
  }
}
