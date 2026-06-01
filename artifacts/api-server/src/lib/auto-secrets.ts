/**
 * Auto-generate and persist ENCRYPTION_KEY and SESSION_SECRET if not set.
 *
 * Priority (highest to lowest):
 *   1. Environment variable (explicitly set by the operator)
 *   2. DATA_DIR/secrets.json (generated on first run, persists across restarts)
 *   3. Generate fresh values, write to secrets.json, apply to process.env
 *
 * In Docker the DATA_DIR is a named volume (/app/data), so generated secrets
 * survive container restarts and upgrades automatically.
 *
 * IMPORTANT: This module calls ensureSecrets() at evaluation time (module
 * level) so that process.env.SESSION_SECRET and ENCRYPTION_KEY are guaranteed
 * to be set before any subsequently imported module reads them. In ESM (and
 * esbuild bundles) static imports are hoisted, so the explicit
 * `ensureSecrets()` call in index.ts body runs AFTER app.ts is evaluated.
 * Calling it here at module level fixes that ordering issue.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

interface SecretsFile {
  encryptionKey: string;
  sessionSecret: string;
}

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SECRETS_PATH = path.join(DATA_DIR, "secrets.json");

function generate64HexBytes(): string {
  return crypto.randomBytes(32).toString("hex");
}

function loadOrCreate(): SecretsFile {
  if (fs.existsSync(SECRETS_PATH)) {
    try {
      const raw = fs.readFileSync(SECRETS_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<SecretsFile>;
      if (parsed.encryptionKey && parsed.sessionSecret) {
        return parsed as SecretsFile;
      }
    } catch {
      // Fall through to generate
    }
  }

  const secrets: SecretsFile = {
    encryptionKey: generate64HexBytes(),
    sessionSecret: generate64HexBytes(),
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });

  return secrets;
}

/**
 * Ensures ENCRYPTION_KEY and SESSION_SECRET are set in process.env.
 * Idempotent — safe to call multiple times.
 */
export function ensureSecrets(): void {
  const needsEncKey = !process.env.ENCRYPTION_KEY;
  const needsSession = !process.env.SESSION_SECRET;

  if (!needsEncKey && !needsSession) return;

  const file = loadOrCreate();

  // #5 — use process.stderr.write instead of console.log so output is:
  //   a) consistent (goes to the same fd pino uses in non-pretty mode)
  //   b) not silently dropped by pino's transport in production
  //   c) not subject to any accidental redact rules
  if (needsEncKey) {
    process.env.ENCRYPTION_KEY = file.encryptionKey;
    process.stderr.write(`{"level":30,"time":${Date.now()},"msg":"ENCRYPTION_KEY loaded from secrets file","path":"${SECRETS_PATH}"}\n`);
  }

  if (needsSession) {
    process.env.SESSION_SECRET = file.sessionSecret;
    process.stderr.write(`{"level":30,"time":${Date.now()},"msg":"SESSION_SECRET loaded from secrets file","path":"${SECRETS_PATH}"}\n`);
  }
}

// Called at module evaluation time — see module-level comment above.
ensureSecrets();
