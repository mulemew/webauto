import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { addSession, hasSession, deleteSession, clearOtherSessions } from "../lib/sessions";
import { loginRateLimit } from "../middlewares/loginRateLimit";
import { requireAuth } from "../middlewares/requireAuth";
import { verifyPassword, changePassword, hasStoredPassword, initPassword } from "../lib/passwordStore";

const router: IRouter = Router();

const SESSION_COOKIE_NAME = "session";
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Use SECURE_COOKIES env var to explicitly control Secure flag on session
// cookies. Defaults to false so HTTP-only Docker deployments work out of the
// box. Set SECURE_COOKIES=true when running behind an HTTPS reverse proxy.
const SECURE_COOKIES = process.env.SECURE_COOKIES === "true";

router.get("/auth/setup-status", async (req, res): Promise<void> => {
  const needsSetup = !process.env.DASHBOARD_PASSWORD && !(await hasStoredPassword());
  res.json({ needsSetup });
});

router.post("/auth/setup", loginRateLimit, async (req, res): Promise<void> => {
  const alreadyConfigured = !!process.env.DASHBOARD_PASSWORD || (await hasStoredPassword());
  if (alreadyConfigured) { res.status(409).json({ error: "Already configured" }); return; }

  const { password } = req.body as { password?: string };
  const result = await initPassword(password ?? "");
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + COOKIE_MAX_AGE_MS);
  await addSession(token, expiresAt);
  res.cookie(SESSION_COOKIE_NAME, token, { signed: true, httpOnly: true, sameSite: "strict", secure: SECURE_COOKIES, path: "/", maxAge: COOKIE_MAX_AGE_MS });
  res.json({ authenticated: true });
});

router.post("/auth/login", loginRateLimit, async (req, res): Promise<void> => {
  if (!process.env.DASHBOARD_PASSWORD && !(await hasStoredPassword())) {
    res.status(503).json({ error: "Server not configured: no password set" }); return;
  }
  const { password } = req.body as { password?: string };
  if (!password) { res.status(401).json({ error: "Invalid password" }); return; }
  const valid = await verifyPassword(password);
  if (!valid) { res.status(401).json({ error: "Invalid password" }); return; }
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + COOKIE_MAX_AGE_MS);
  await addSession(token, expiresAt);
  res.cookie(SESSION_COOKIE_NAME, token, { signed: true, httpOnly: true, sameSite: "strict", secure: SECURE_COOKIES, path: "/", maxAge: COOKIE_MAX_AGE_MS });
  res.json({ authenticated: true });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = req.signedCookies?.[SESSION_COOKIE_NAME];
  if (typeof token === "string") await deleteSession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ authenticated: false });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const token = req.signedCookies?.[SESSION_COOKIE_NAME];
  if (typeof token === "string" && (await hasSession(token))) { res.json({ authenticated: true }); return; }
  res.json({ authenticated: false });
});

// #2 — loginRateLimit added to change-password to prevent brute-force
router.put("/auth/password", requireAuth, loginRateLimit, async (req, res): Promise<void> => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) { res.status(400).json({ error: "currentPassword and newPassword are required" }); return; }
  const result = await changePassword(currentPassword, newPassword);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  const newToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + COOKIE_MAX_AGE_MS);
  await addSession(newToken, expiresAt);
  await clearOtherSessions(newToken);
  res.cookie(SESSION_COOKIE_NAME, newToken, { signed: true, httpOnly: true, sameSite: "strict", secure: SECURE_COOKIES, path: "/", maxAge: COOKIE_MAX_AGE_MS });
  res.json({ ok: true });
});

export default router;
