// src/routes/auth.ts
import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../utils/db.js";
import { loginSchema, registerSchema } from "../middleware/schemas.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /auth/register ──────────────────────────────────────────────────
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Validation error", details: body.error.format() });

    const { username, email, password } = body.data;

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing) return reply.code(409).send({ error: "Username or email already taken" });

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { username, email, hashedPassword },
      select: { id: true, username: true, email: true, createdAt: true },
    });

    return reply.code(201).send(user);
  });

  // ── POST /auth/login ─────────────────────────────────────────────────────
  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Validation error" });

    const { username, password } = body.data;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.hashedPassword))) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    if (!user.isActive) {
      return reply.code(403).send({ error: "Account is inactive" });
    }

    const token = app.jwt.sign(
      { sub: user.id, username: user.username },
      { expiresIn: "1h" }
    );

    return { accessToken: token, tokenType: "Bearer" };
  });

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  app.get("/auth/me", {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: (req.user as any).sub },
      select: { id: true, username: true, email: true, isActive: true, createdAt: true },
    });
    if (!user) return reply.code(404).send({ error: "User not found" });
    return user;
  });
}
