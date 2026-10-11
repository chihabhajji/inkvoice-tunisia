import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { clientIp, rateLimiter } from "../middleware/rate-limiter";
import { logActivity } from "../services/activity.service";
import { getCurrentUser, verifyCredentials } from "../services/auth.service";
import {
  createDeviceSession,
  listDeviceSessions,
  revokeDeviceSession,
} from "../services/device-session.service";

// Mounted at /api/v1/auth/device-sessions, i.e. before the global auth
// middleware: sign-in is public, everything else opts into authMiddleware.
const deviceSessions = new Hono();

const optionalText = z.string().max(100).nullish();

const signInSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  device: z.object({
    name: z.string().trim().min(1, "Device name is required").max(100),
    platform: z.enum(["ios", "android"]),
    model: optionalText,
    os_version: optionalText,
    app_version: optionalText,
  }),
});

function requestIp(c: Parameters<typeof clientIp>[0]): string | null {
  const ip = clientIp(c);
  return ip === "unknown" ? null : ip;
}

// Password sign-in for the mobile app. Shares the login limiter and the
// credential check with /auth/login, but returns an opaque bearer token and
// never sets a cookie. Tenancy needs no extra binding: the session row is
// written to the request's (tenant) DB, the only place it can be found again.
deviceSessions.post("/", rateLimiter, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = signInSchema.parse(body);

  const user = await verifyCredentials(parsed.username, parsed.password);
  if (!user) {
    return c.json(
      { success: false, error: "Invalid credentials", code: "INVALID_CREDENTIALS" },
      401,
    );
  }

  const { token, session } = createDeviceSession(user.id, parsed.device, requestIp(c));

  logActivity({
    user_id: user.id,
    user_name: user.username,
    action: "login",
    resource_type: "user",
    resource_id: user.id,
    metadata: { method: "device_session", platform: session.platform, device: session.name },
  });

  return c.json({ success: true, data: { token, session, user: getCurrentUser(user.id) } }, 201);
});

deviceSessions.get("/", authMiddleware, (c) => {
  const currentId = c.get("deviceSession")?.id;
  const data = listDeviceSessions(c.get("userId")).map((s) => ({
    ...s,
    current: s.id === currentId,
  }));
  return c.json({ success: true, data });
});

// Registered before /:id so "current" is never read as an id.
deviceSessions.delete("/current", authMiddleware, (c) => {
  const current = c.get("deviceSession");
  if (!current) {
    return c.json(
      {
        success: false,
        error: "This request is not using a device session",
        code: "NOT_A_DEVICE_SESSION",
      },
      400,
    );
  }
  revokeDeviceSession(current.id, c.get("userId"), "signed_out");
  return c.json({ success: true });
});

deviceSessions.delete("/:id", authMiddleware, (c) => {
  const ok = revokeDeviceSession(c.req.param("id") ?? "", c.get("userId"), "revoked_by_user");
  if (!ok) return c.json({ success: false, error: "Device session not found" }, 404);
  return c.json({ success: true });
});

export { deviceSessions };
