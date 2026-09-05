import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "./db";

/**
 * Database-backed sessions. The socket handshake reads the same session cookie
 * this issues and verifies it server-side (see server/socket.ts), so the
 * browser and the socket share one notion of who the user is.
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // No mail transport in this project; a reviewer signs in immediately.
    requireEmailVerification: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    database: { joins: true },
  },
});

export type Session = typeof auth.$Infer.Session;
