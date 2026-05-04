// src/services/anomaly.ts
//
// Real-time anomaly detection for sensor streams.
//
// Three complementary detectors, all pure TypeScript / math — no ML library needed:
//   1. Rolling Z-score  — fast, interpretable
//   2. IQR fence        — robust to heavy-tailed distributions
//   3. CUSUM            — catches slow drifts that single-sample tests miss
//
// A reading is flagged anomalous when ≥2 detectors agree.

import { DetectionResult } from "../types/index.js";
import { config } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Rolling circular buffer
// ---------------------------------------------------------------------------
class RingBuffer {
  private buf: Float64Array;
  private head = 0;
  private _size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  get size(): number { return this._size; }
  get ready(): boolean { return this._size >= Math.max(10, this.capacity / 3); }

  toArray(): Float64Array {
    if (this._size < this.capacity) return this.buf.slice(0, this._size);
    // reconstruct in order
    const out = new Float64Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Per-sensor state
// ---------------------------------------------------------------------------
interface SensorState {
  history: RingBuffer;
  cusumPos: number;  // CUSUM positive accumulator
  cusumNeg: number;  // CUSUM negative accumulator
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function mean(arr: Float64Array): number {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function std(arr: Float64Array, mu: number): number {
  let s = 0;
  for (const v of arr) s += (v - mu) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

function percentile(sorted: Float64Array, p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// AnomalyDetector
// ---------------------------------------------------------------------------
export class AnomalyDetector {
  private states = new Map<number, SensorState>();
  private readonly windowSize: number;
  private readonly zThreshold: number;
  private readonly cusumK = 0.5;   // allowance (in σ)
  private readonly cusumH = 5.0;   // decision threshold (in σ)

  constructor() {
    this.windowSize = config.ANOMALY_WINDOW;
    this.zThreshold = config.ANOMALY_Z_THRESHOLD;
  }

  detect(sensorId: number, value: number): DetectionResult {
    if (!this.states.has(sensorId)) {
      this.states.set(sensorId, {
        history: new RingBuffer(this.windowSize),
        cusumPos: 0,
        cusumNeg: 0,
      });
    }
    const state = this.states.get(sensorId)!;
    const fired: string[] = [];
    const scores: number[] = [];

    if (state.history.ready) {
      const arr = state.history.toArray();
      const mu  = mean(arr);
      const s   = std(arr, mu);

      // ── 1. Z-score ────────────────────────────────────────────────────────
      if (s > 1e-9) {
        const z = (value - mu) / s;
        if (Math.abs(z) > this.zThreshold) {
          fired.push("z_score");
          scores.push(Math.abs(z));
        }

        // ── 3. CUSUM (uses z-normalised deviation) ─────────────────────────
        const k = this.cusumK * s;
        state.cusumPos = Math.max(0, state.cusumPos + (value - mu - k));
        state.cusumNeg = Math.max(0, state.cusumNeg + (mu - k - value));
        const cusumThresh = this.cusumH * s;
        if (state.cusumPos > cusumThresh || state.cusumNeg > cusumThresh) {
          fired.push("cusum");
          scores.push(Math.max(state.cusumPos, state.cusumNeg) / s);
          // Reset CUSUM after trigger
          state.cusumPos = 0;
          state.cusumNeg = 0;
        }
      }

      // ── 2. IQR fence ──────────────────────────────────────────────────────
      const sorted = Float64Array.from(arr).sort();
      const q1  = percentile(sorted, 25);
      const q3  = percentile(sorted, 75);
      const iqr = q3 - q1;
      if (iqr > 1e-9) {
        const lo = q1 - 2.0 * iqr;
        const hi = q3 + 2.0 * iqr;
        if (value < lo || value > hi) {
          fired.push("iqr");
          scores.push(Math.max(lo - value, value - hi) / iqr);
        }
      }
    }

    state.history.push(value);

    // Majority vote: anomaly if ≥2 detectors fire
    const isAnomaly = fired.length >= 2;
    const anomalyScore = scores.length > 0 ? Math.max(...scores) : 0;

    return {
      isAnomaly,
      anomalyScore: Math.round(anomalyScore * 10_000) / 10_000,
      detectorsFired: fired,
    };
  }

  resetSensor(sensorId: number): void {
    this.states.delete(sensorId);
  }
}

// Module-level singleton
let _detector: AnomalyDetector | null = null;
export function getDetector(): AnomalyDetector {
  if (!_detector) _detector = new AnomalyDetector();
  return _detector;
}
