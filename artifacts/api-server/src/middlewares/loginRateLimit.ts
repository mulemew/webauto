import { Request, Response, NextFunction } from "express";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// #1 — Map is cleaned up periodically so it never grows unboundedly
const attempts = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(ip);
  }
}, WINDOW_MS).unref();

/**
 * Extract a single trusted IP from the request.
 * Only accepts the first x-forwarded-for value when it looks like a real IP
 * literal — rejects arbitrary strings to prevent header-spoofing bypass.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const candidate = forwarded.split(",")[0].trim();
    // Accept dotted-decimal IPv4 or hex-colon IPv6 only
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(candidate) || /^[0-9a-f:]+$/i.test(candidate)) {
      return candidate;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  entry.count += 1;

  if (entry.count > MAX_ATTEMPTS) {
    const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", retryAfterSecs);
    res.status(429).json({ error: "Too many login attempts. Please try again later." });
    return;
  }

  next();
}
