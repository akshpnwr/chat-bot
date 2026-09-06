import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "./db";
import { createSignInThrottle } from "@/server/sign-in-throttle";

/**
 * The sign-in throttle, at module scope so it outlives a request.
 *
 * Built here rather than inside a hook because a limiter constructed per
 * request counts to one and forgets. Its rules live in
 * `src/server/sign-in-throttle.ts`; what this file decides is only where they
 * are applied.
 */
const signInThrottle = createSignInThrottle();

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
  /**
   * Throttling repeated failed sign-ins, in two halves.
   *
   * The `before` hook consumes an attempt *ahead of* the password check, which
   * is the ordering that matters: verification is deliberately expensive, so a
   * flood refused here never reaches it. The `after` hook releases the attempt
   * when a session came back, which is what makes this count failures only --
   * somebody signing into their own account repeatedly is not an attack.
   *
   * Both branch on the path rather than being registered per endpoint, because
   * Better Auth takes one middleware for each phase.
   */
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const refusal = signInThrottle.attempt(ctx.body?.email);
      if (refusal === null) return;

      throw new APIError("TOO_MANY_REQUESTS", {
        // The interval is in the message rather than only beside it, because
        // this is the one refusal whose whole audience is a person reading a
        // form. `retryAfterMs` is carried too, for a client that wants to
        // disable the button rather than print a sentence.
        message: `${refusal.message} (about ${Math.ceil(
          refusal.retryAfterMs / 1000,
        )} seconds)`,
        retryAfterMs: refusal.retryAfterMs,
        // The standard header as well, so this path answers a 429 the same way
        // the upload route does -- ADR-0008 claims both do, and an intermediary
        // that understands backing off should not have to read our JSON.
        headers: {
          "Retry-After": String(Math.ceil(refusal.retryAfterMs / 1000)),
        },
      });
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      // A session is the only proof the credentials were right; a failed
      // sign-in leaves its attempt counted, which is the whole mechanism.
      if (ctx.context.newSession) {
        signInThrottle.succeeded(ctx.body?.email);
      }
    }),
  },
  // Lets server actions set the session cookie. Must stay last in the list.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
