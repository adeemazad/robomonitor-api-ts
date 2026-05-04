// src/types/fastify.d.ts
import { JwtPayload } from "./index.js";

declare module "fastify" {
  interface FastifyRequest {
    user: JwtPayload;
  }
}
