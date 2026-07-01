/**
 * proxy-manager — normalises a wide range of proxy specifications into a
 * Chromium-consumable proxy server URL.
 *
 * Chromium (and therefore Playwright / Puppeteer / SeleniumBase) can only speak
 * to a proxy via `--proxy-server=` using one of:
 *   http://  https://  socks5://  socks4://
 *
 * Modern node protocols (VLESS / VMess / Trojan / Hysteria2 / Cloudflare WARP)
 * are NOT understood by Chromium directly. For those we start a local
 * `sing-box` client that dials the upstream node and exposes a plain local
 * SOCKS5 inbound on 127.0.0.1:<port>. The browser is then pointed at that
 * local SOCKS5, so from Chromium's perspective every task just uses a normal
 * SOCKS5 proxy.
 *
 * Supported `proxyType` values:
 *   - "http"     — passthrough http/https proxy URL
 *   - "socks5"   — passthrough socks5/socks4 proxy URL
 *   - "warp"     — Cloudflare WARP (WireGuard) via sing-box
 *   - "vless"    — VLESS node (share link or JSON) via sing-box
 *   - "vmess"    — VMess node (vmess:// base64 link) via sing-box
 *   - "trojan"   — Trojan node (trojan:// link) via sing-box
 *   - "hy2"      — Hysteria2 node (hysteria2:// / hy2:// link) via sing-box
 *
 * The heavy protocols require the `sing-box` binary to be installed on the
 * host (see Dockerfile). If it is missing, startLocalProxy throws a clear
 * error telling the operator how to enable it.
 */
import { spawn, type ChildProcess, execSync } from "child_process";
import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import { logger } from "../lib/logger";

export type ProxyType =
  | "http"
  | "socks5"
  | "warp"
  | "vless"
  | "vmess"
  | "trojan"
  | "hy2";

/** Per-task proxy configuration, stored inside browserConfig. */
export interface ProxyConfig {
  /** Which kind of proxy this is. Defaults to inferring from proxyUrl scheme. */
  proxyType?: ProxyType;
  /**
   * The proxy address. Meaning depends on proxyType:
   *   http/socks5 — a full proxy URL (http://user:pass@host:port, socks5://host:1080)
   *   vless/vmess/trojan/hy2 — the share link (vless://…, vmess://…, trojan://…, hysteria2://…)
   *   warp — optional; leave blank to use a free WARP registration
   */
  proxyUrl?: string;
}

/**
 * A running local proxy. `serverUrl` is what Chromium should be pointed at.
 * `stop()` tears down any spawned helper process. For passthrough proxies
 * there is no process and stop() is a no-op.
 */
export interface ResolvedProxy {
  serverUrl: string;
  stop: () => Promise<void>;
}

const SINGBOX_PROTOCOLS: ProxyType[] = [
  "warp",
  "vless",
  "vmess",
  "trojan",
  "hy2",
];

/** Infer the proxy type from an explicit type or the URL scheme. */
export function resolveProxyType(cfg: ProxyConfig): ProxyType | null {
  if (cfg.proxyType) return cfg.proxyType;
  const url = (cfg.proxyUrl ?? "").trim();
  if (!url) return null;
  if (/^socks5?:\/\//i.test(url)) return "socks5";
  if (/^https?:\/\//i.test(url)) return "http";
  if (/^vless:\/\//i.test(url)) return "vless";
  if (/^vmess:\/\//i.test(url)) return "vmess";
  if (/^trojan:\/\//i.test(url)) return "trojan";
  if (/^(hysteria2|hy2):\/\//i.test(url)) return "hy2";
  return null;
}

/** True when this proxy type needs a local sing-box helper. */
export function needsLocalHelper(type: ProxyType): boolean {
  return SINGBOX_PROTOCOLS.includes(type);
}

function hasSingBox(): boolean {
  try {
    execSync("which sing-box", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Find a free localhost TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not determine a free port")));
      }
    });
  });
}

/** Wait until a local TCP port is accepting connections (helper is ready). */
async function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Local proxy helper did not open port ${port} within ${timeoutMs}ms`,
  );
}

// ── Share-link parsers → sing-box outbound JSON ────────────────────────────

function decodeBase64(s: string): string {
  return Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

/** Parse a vmess:// base64 JSON link into a sing-box vmess outbound. */
function parseVmess(link: string): Record<string, unknown> {
  const raw = link.replace(/^vmess:\/\//i, "").trim();
  const json = JSON.parse(decodeBase64(raw)) as Record<string, string>;
  const tls = String(json.tls ?? "") === "tls";
  const outbound: Record<string, unknown> = {
    type: "vmess",
    tag: "proxy",
    server: json.add,
    server_port: parseInt(String(json.port), 10),
    uuid: json.id,
    security: json.scy || "auto",
    alter_id: parseInt(String(json.aid ?? "0"), 10),
  };
  if (tls)
    outbound.tls = {
      enabled: true,
      server_name: json.sni || json.host || json.add,
      insecure: true,
    };
  const net = json.net || "tcp";
  if (net === "ws") {
    outbound.transport = {
      type: "ws",
      path: json.path || "/",
      headers: json.host ? { Host: json.host } : undefined,
    };
  } else if (net === "grpc") {
    outbound.transport = { type: "grpc", service_name: json.path || "" };
  }
  return outbound;
}

/** Parse a vless:// link into a sing-box vless outbound. */
function parseVless(link: string): Record<string, unknown> {
  const u = new URL(link);
  const params = u.searchParams;
  const security = params.get("security") || "none";
  const outbound: Record<string, unknown> = {
    type: "vless",
    tag: "proxy",
    server: u.hostname,
    server_port: parseInt(u.port || "443", 10),
    uuid: decodeURIComponent(u.username),
    flow: params.get("flow") || "",
  };
  if (security === "tls" || security === "reality") {
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: params.get("sni") || u.hostname,
      insecure: true,
    };
    const fp = params.get("fp");
    if (fp) tls.utls = { enabled: true, fingerprint: fp };
    if (security === "reality") {
      tls.reality = {
        enabled: true,
        public_key: params.get("pbk") || "",
        short_id: params.get("sid") || "",
      };
    }
    outbound.tls = tls;
  }
  const type = params.get("type") || "tcp";
  if (type === "ws") {
    outbound.transport = {
      type: "ws",
      path: params.get("path") || "/",
      headers: params.get("host") ? { Host: params.get("host") } : undefined,
    };
  } else if (type === "grpc") {
    outbound.transport = {
      type: "grpc",
      service_name: params.get("serviceName") || "",
    };
  }
  return outbound;
}

/** Parse a trojan:// link into a sing-box trojan outbound. */
function parseTrojan(link: string): Record<string, unknown> {
  const u = new URL(link);
  const params = u.searchParams;
  const outbound: Record<string, unknown> = {
    type: "trojan",
    tag: "proxy",
    server: u.hostname,
    server_port: parseInt(u.port || "443", 10),
    password: decodeURIComponent(u.username),
    tls: {
      enabled: true,
      server_name: params.get("sni") || u.hostname,
      insecure: true,
    },
  };
  const type = params.get("type");
  if (type === "ws") {
    outbound.transport = {
      type: "ws",
      path: params.get("path") || "/",
      headers: params.get("host") ? { Host: params.get("host") } : undefined,
    };
  }
  return outbound;
}

/** Parse a hysteria2:// / hy2:// link into a sing-box hysteria2 outbound. */
function parseHy2(link: string): Record<string, unknown> {
  const u = new URL(link.replace(/^hy2:\/\//i, "hysteria2://"));
  const params = u.searchParams;
  return {
    type: "hysteria2",
    tag: "proxy",
    server: u.hostname,
    server_port: parseInt(u.port || "443", 10),
    password: decodeURIComponent(u.username || params.get("password") || ""),
    tls: {
      enabled: true,
      server_name: params.get("sni") || u.hostname,
      insecure: true,
    },
  };
}

/** WARP: a WireGuard outbound. Uses a locally registered WARP config file if present. */
function parseWarp(): Record<string, unknown> {
  // A WARP WireGuard config generated by `wgcf` / warp-reg can be mounted at
  // WARP_CONFIG_PATH (sing-box outbound JSON). If absent, we cannot fabricate
  // valid WireGuard keys, so instruct the operator.
  const cfgPath = process.env.WARP_CONFIG_PATH;
  if (cfgPath && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;
    return { tag: "proxy", ...cfg };
  }
  throw new Error(
    "WARP proxy requires a pre-generated WireGuard outbound. Set WARP_CONFIG_PATH to a sing-box " +
      "WireGuard outbound JSON (generate it with wgcf/warp-reg). See README for details.",
  );
}

function buildOutbound(type: ProxyType, link: string): Record<string, unknown> {
  switch (type) {
    case "vmess":
      return parseVmess(link);
    case "vless":
      return parseVless(link);
    case "trojan":
      return parseTrojan(link);
    case "hy2":
      return parseHy2(link);
    case "warp":
      return parseWarp();
    default:
      throw new Error(
        `buildOutbound: unsupported sing-box proxy type "${type}"`,
      );
  }
}

/**
 * Start a local sing-box that exposes a SOCKS5 inbound on 127.0.0.1 and
 * forwards to the given upstream node. Returns the local socks URL + a stop().
 */
async function startSingBox(
  type: ProxyType,
  link: string,
): Promise<ResolvedProxy> {
  if (!hasSingBox()) {
    throw new Error(
      `Proxy type "${type}" needs the sing-box binary, which is not installed on this host. ` +
        `Install it (https://sing-box.sagernet.org) or use an http/socks5 proxy instead.`,
    );
  }
  const port = await getFreePort();
  const outbound = buildOutbound(type, link);
  const config = {
    log: { level: "warn" },
    inbounds: [
      { type: "socks", tag: "in", listen: "127.0.0.1", listen_port: port },
    ],
    outbounds: [outbound, { type: "direct", tag: "direct" }],
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "singbox-"));
  const cfgFile = path.join(dir, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify(config));

  const child: ChildProcess = spawn("sing-box", ["run", "-c", cfgFile], {
    stdio: "ignore",
  });
  child.on("error", (err) => logger.error({ err }, "sing-box process error"));

  try {
    await waitForPort(port);
  } catch (err) {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  logger.info({ type, localPort: port }, "Local sing-box proxy started");

  return {
    serverUrl: `socks5://127.0.0.1:${port}`,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      logger.info({ localPort: port }, "Local sing-box proxy stopped");
    },
  };
}

/**
 * Resolve a ProxyConfig into a Chromium-usable proxy. For passthrough proxies
 * this returns the URL directly. For advanced protocols it starts a local
 * sing-box helper and returns the local SOCKS5 URL.
 *
 * Returns null when no proxy is configured.
 */
export async function startLocalProxy(
  cfg: ProxyConfig,
): Promise<ResolvedProxy | null> {
  const type = resolveProxyType(cfg);
  if (!type) return null;

  const url = (cfg.proxyUrl ?? "").trim();

  // Passthrough: Chromium speaks http/socks directly.
  if (type === "http" || type === "socks5") {
    if (!url) return null;
    return { serverUrl: url, stop: async () => {} };
  }

  // WARP with no link is allowed (uses WARP_CONFIG_PATH); others need a link.
  if (type !== "warp" && !url) {
    throw new Error(
      `Proxy type "${type}" requires a node share link in the proxy address field.`,
    );
  }

  return startSingBox(type, url);
}

/** Human-readable label for each proxy type (for UI/logging). */
export const PROXY_TYPE_LABELS: Record<ProxyType, string> = {
  http: "HTTP/HTTPS",
  socks5: "SOCKS5",
  warp: "Cloudflare WARP",
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  hy2: "Hysteria2",
};
