// src/middleware/auth.ts
import { FastifyRequest, FastifyReply } from "fastify";
import { JwtPayload } from "../types/index.js";

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}

// Helper to get typed user from request
export function getUser(req: FastifyRequest): JwtPayload {
  return req.user as unknown as JwtPayload;
}
