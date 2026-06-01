import { Request, Response, NextFunction } from "express";
import { hasSession } from "../lib/sessions";

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.signedCookies?.["session"];
  if (typeof token === "string" && (await hasSession(token))) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}
