import { scrypt, randomBytes, timingSafeEqual, createHash } from "crypto";
  import { promisify } from "util";
  import { db, settingsTable, eq } from "@workspace/db";

  const scryptAsync = promisify(scrypt);

  const PASSWORD_KEY = "passwordHash";

  type PasswordStore = {
    hash: string;
    salt: string;
  };

  async function hashPassword(password: string, salt: string): Promise<string> {
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    return derivedKey.toString("hex");
  }

  async function loadStore(): Promise<PasswordStore | null> {
    const [row] = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, PASSWORD_KEY));
    if (!row) return null;
    try {
      return JSON.parse(row.value) as PasswordStore;
    } catch {
      return null;
    }
  }

  async function savePassword(password: string): Promise<void> {
    const salt = randomBytes(16).toString("hex");
    const hash = await hashPassword(password, salt);
    const value = JSON.stringify({ hash, salt });
    await db
      .insert(settingsTable)
      .values({ key: PASSWORD_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  }

  export async function hasStoredPassword(): Promise<boolean> {
    const [row] = await db
      .select({ key: settingsTable.key })
      .from(settingsTable)
      .where(eq(settingsTable.key, PASSWORD_KEY));
    return !!row;
  }

  export async function verifyPassword(candidate: string): Promise<boolean> {
    const store = await loadStore();
    if (!store) {
      const envPassword = process.env.DASHBOARD_PASSWORD;
      if (!envPassword) return false;
      // #fix-timing — hash both sides to a fixed-length digest before comparing.
      // Previously a direct length check caused early return, leaking the password
      // length via response timing. SHA-256 normalises both to 32 bytes so
      // timingSafeEqual always runs in constant time regardless of input length.
      const a = createHash("sha256").update(candidate).digest();
      const b = createHash("sha256").update(envPassword).digest();
      return timingSafeEqual(a, b);
    }
    const candidateHash = await hashPassword(candidate, store.salt);
    const storedHash = Buffer.from(store.hash, "hex");
    const candidateBuf = Buffer.from(candidateHash, "hex");
    if (storedHash.length !== candidateBuf.length) return false;
    return timingSafeEqual(storedHash, candidateBuf);
  }

  /** Set the initial password. Only intended for first-run setup. */
  export async function initPassword(password: string): Promise<{ ok: boolean; error?: string }> {
    if (!password || password.length < 8) {
      return { ok: false, error: "Password must be at least 8 characters" };
    }
    await savePassword(password);
    return { ok: true };
  }

  export async function changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: boolean; error?: string }> {
    const valid = await verifyPassword(currentPassword);
    if (!valid) {
      return { ok: false, error: "Current password is incorrect" };
    }
    if (!newPassword || newPassword.length < 8) {
      return { ok: false, error: "New password must be at least 8 characters" };
    }
    await savePassword(newPassword);
    return { ok: true };
  }
