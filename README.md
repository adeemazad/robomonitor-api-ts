# RoboMonitor API

> **Production-grade robot telemetry API** - real-time sensor ingestion, ML anomaly detection, WebSocket streaming, JWT auth, Prisma ORM, Docker deployment.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-20-green.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-19%20passing-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What it does

RoboMonitor ingests high-frequency sensor streams from robot hardware, runs three complementary anomaly detectors (Z-score, IQR fence, CUSUM) in real-time, pushes alerts to subscribed clients over WebSocket, and exposes a clean REST API for fleet management and historical analysis.

**The `/ws/demo` endpoint streams a live physics-based 6-DOF robot arm simulation — no auth, no setup, just connect and watch anomalies fire in real time.** Try it instantly:

```bash
# With wscat (npm i -g wscat)
wscat -c ws://localhost:3000/ws/demo
```

---

## Architecture

```
             POST /api/v1/robots/:id/readings
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│              Ingestion Pipeline (per reading)          │
│                                                        │
│  1. Ownership + sensor validation                      │
│  2. Anomaly detection (Z-score + IQR + CUSUM)          │
│  3. Persist reading + alert to SQLite/PostgreSQL       │
│  4. Push WS event to subscribed clients                │
└────────────────────────────────────────────────────────┘
        │                         │
        ▼                         ▼
  Prisma ORM               WebSocket Manager
  SQLite (dev)             per-robot subscriptions
  PostgreSQL (prod)        + global broadcast
```

```
┌──────────────────────────────────────────────────────────────┐
│  REST API (Fastify)          WebSocket endpoints             │
│  POST /auth/register         ws://.../ws/robots/:id          │
│  POST /auth/login            ws://.../ws/demo  ← try this!   │
│  GET  /robots                                                │
│  POST /robots/:id/readings   ← core ingestion endpoint       │
│  GET  /robots/:id/stats                                      │
│  GET  /robots/:id/alerts                                     │
│  GET  /docs  ← Swagger UI                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## Quickstart (3 commands)

```bash
# 1. Install
npm install

# 2. Push DB schema (SQLite, zero setup)
cp .env.example .env
npx prisma db push

# 3. Run
npm run dev
```

API docs: http://localhost:3000/docs  
Live demo stream: `wscat -c ws://localhost:3000/ws/demo`

---

## Full API walkthrough

```bash
# Register
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"SecurePass123"}'

# Login → get token
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"SecurePass123"}' | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).accessToken))")

# Create robot
curl -X POST http://localhost:3000/api/v1/robots \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Arm A","model":"UR5e","serial":"SN-001"}'

# Create sensor (use robotId from above)
curl -X POST http://localhost:3000/api/v1/robots/1/sensors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"joint1_angle","type":"JOINT_ANGLE","unit":"deg","minVal":-180,"maxVal":180}'

# Ingest a batch of readings (triggers anomaly detection)
curl -X POST http://localhost:3000/api/v1/robots/1/readings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"readings":[{"sensorId":1,"value":45.2},{"sensorId":1,"value":46.0}]}'

# Check stats
curl http://localhost:3000/api/v1/robots/1/stats \
  -H "Authorization: Bearer $TOKEN"

# View anomaly alerts
curl http://localhost:3000/api/v1/robots/1/alerts \
  -H "Authorization: Bearer $TOKEN"
```

---

## Anomaly detection — how it works

Three independent detectors run on every reading. A reading is flagged **anomalous when ≥2 agree**.

| Detector | Method | Good at |
|----------|--------|---------|
| **Z-score** | Rolling mean ± σ, fires if \|z\| > 3.5 | Sharp spikes |
| **IQR fence** | Tukey fences with k=2.0 | Outliers in skewed data |
| **CUSUM** | Cumulative sum of deviations | Slow drift, gradual failures |

All implemented in pure TypeScript — no ML library, no Python dependency. Each sensor maintains its own rolling state in a `Float64Array` ring buffer (O(1) push, minimal GC pressure).

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 20 | LTS, native ESM, excellent async |
| Framework | Fastify 4 | 2× faster than Express, built-in schema validation, great plugin ecosystem |
| Language | TypeScript 5 (strict) | Full type safety, better IDE support |
| ORM | Prisma 5 | Type-safe queries, migration system, multi-DB |
| Database | SQLite (dev) / PostgreSQL (prod) | Zero-setup dev, production-grade prod |
| Auth | @fastify/jwt (RS256-compatible) + bcrypt | Stateless, scalable |
| Validation | Zod | Parse-don't-validate, excellent error messages |
| WebSocket | @fastify/websocket | Native ws, no socket.io overhead |
| Docs | @fastify/swagger + swagger-ui | Auto-generated OpenAPI 3.0 |
| Testing | Vitest | Fast, ESM-native, Jest-compatible API |
| Logging | Pino (structured JSON) | 5× faster than Winston, Datadog/ELK ready |
| Container | Docker (multi-stage) | Non-root user, minimal image |
| CI/CD | GitHub Actions | Test → build → container smoke test |

---

## Project structure

```
robomonitor-api/
├── src/
│   ├── app.ts                   # Fastify app factory (testable, no side effects)
│   ├── server.ts                # Entrypoint: listen + graceful shutdown
│   ├── routes/
│   │   ├── auth.ts              # Register, login, /me
│   │   ├── robots.ts            # Robot CRUD + sensors + stats
│   │   ├── telemetry.ts         # Reading ingestion, alerts, history
│   │   └── ws.ts                # WebSocket: robot stream + demo
│   ├── services/
│   │   ├── anomaly.ts           # Z-score + IQR + CUSUM detectors
│   │   ├── simulator.ts         # Physics-based 6-DOF robot simulator
│   │   └── wsManager.ts         # Connection registry + broadcast
│   ├── middleware/
│   │   ├── auth.ts              # JWT preHandler
│   │   └── schemas.ts           # Zod validation schemas
│   ├── types/
│   │   ├── index.ts             # Shared interfaces
│   │   └── fastify.d.ts         # Module augmentation
│   └── utils/
│       ├── config.ts            # Zod-validated env config
│       └── db.ts                # Prisma singleton
├── prisma/
│   └── schema.prisma            # DB schema (SQLite → PostgreSQL swap is 1 line)
├── tests/
│   ├── unit.test.ts             # 19 pure logic tests (no DB needed)
│   └── api.test.ts              # Integration tests (requires DB)
├── .github/workflows/ci.yml     # Test → build → Docker smoke test
├── Dockerfile                   # Multi-stage, non-root user
├── .env.example
└── README.md
```

---

## Tests

```bash
npm test               # 19 unit tests (anomaly, simulator, schemas, config)
npm run test:watch     # Watch mode during development
npm run test:coverage  # Coverage report

# Integration tests (requires local DB):
npx prisma db push && npm run test:integration
```

---

## Production deployment

### Switch to PostgreSQL

1. In `prisma/schema.prisma`, change `provider = "sqlite"` → `provider = "postgresql"`
2. Set `DATABASE_URL=postgresql://user:pass@host:5432/robomonitor` in `.env`
3. `npx prisma db push`

### Docker

```bash
docker build -t robomonitor .
docker run -p 3000:3000 \
  -e DATABASE_URL="file:./prod.db" \
  -e JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  robomonitor
```

### One-click cloud (Railway / Render / Fly.io)

All three support `Dockerfile` deploys with zero config. Set `DATABASE_URL` and `JWT_SECRET` as environment secrets. Railway auto-provisions PostgreSQL with one click.

---

## Switching to production DB

```prisma
// prisma/schema.prisma — change only these 2 lines:
datasource db {
  provider = "postgresql"    // was "sqlite"
  url      = env("DATABASE_URL")
}
```

Then: `npx prisma migrate dev --name init`


---
