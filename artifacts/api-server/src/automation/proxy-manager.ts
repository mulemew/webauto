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
 * `sing-box` client that dials the upstream node and exposes a plain SOCKS5
 * inbound. The browser is then pointed at that SOCKS5, so from Chromium's
 * perspective every task just uses a normal SOCKS5 proxy.
 *
 * IMPORTANT — reachability across containers:
 *   The browser that consumes this proxy may NOT run in the same container as
 *   this process. With BROWSER_PROVIDER=browserless / seleniumbase / remote the
 *   browser lives in a separate container, so a `127.0.0.1:<port>` proxy URL
 *   would resolve to *that* container's own loopback and fail. sing-box is
 *   therefore bound to `0.0.0.0` (override with SINGBOX_PROXY_LISTEN_HOST) and
 *   the proxy URL handed to the browser advertises a reachable host
 *   (SINGBOX_PROXY_PUBLIC_HOST, e.g. the app's service name `app` on a Docker
 *   network, or the host IP with host networking). It defaults to 127.0.0.1
 *   for the local provider where the browser shares this container.
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
  | "hy2"
  | "tuic"
  | "ss";

function getSingBoxListenHost(): string {
  return process.env.SINGBOX_PROXY_LISTEN_HOST?.trim() || process.env.PROXY_LISTEN_HOST?.trim() || "0.0.0.0";
}

/**
 * The host that the *browser* should dial to reach the sing-box SOCKS5 inbound.
 *
 *   - Local provider (browser shares this container): 127.0.0.1 is correct and
 *     safest — nothing outside the container can reach the proxy.
 *   - Remote provider (browser in a separate container: browserless / cf-proxy /
 *     remote CDP): 127.0.0.1 would resolve to *that* container's loopback and
 *     fail. We must advertise an address reachable from the other container.
 *
 * Resolution order:
 *   1. SINGBOX_PROXY_PUBLIC_HOST / PROXY_PUBLIC_HOST env override (explicit).
 *   2. For a remote consumer: this container's first non-internal IPv4 address
 *      (reachable by sibling containers on the same Docker network, or by the
 *      host in host-networking mode).
 *   3. Fallback: 127.0.0.1.
 */
function getSingBoxPublicHost(remoteConsumer: boolean): string {
  const explicit = process.env.SINGBOX_PROXY_PUBLIC_HOST?.trim() || process.env.PROXY_PUBLIC_HOST?.trim();
  if (explicit) return explicit;
  if (!remoteConsumer) return "127.0.0.1";
  return detectReachableIPv4() || "127.0.0.1";
}

/** First non-internal IPv4 address of this host/container, or null. */
function detectReachableIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** Attempt a TCP connection to verify that a host can reach the SOCKS port. */
function canConnectToHost(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

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
  "tuic",
  "ss",
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
  if (/^tuic:\/\//i.test(url)) return "tuic";
  if (/^ss:\/\//i.test(url)) return "ss";
  return null;
}

/** True when this proxy type needs a local sing-box helper. */
export function needsLocalHelper(type: ProxyType): boolean {
  return SINGBOX_PROTOCOLS.includes(type);
}

function hasSingBox(): boolean {
  return !!resolveSingBoxBin();
}

/**
 * Resolve the path to a usable sing-box binary, or null if none is found.
 * Checks (in order): SINGBOX_BIN env override, the system PATH, a couple of
 * common install locations, and a runtime-downloaded copy under DATA_DIR.
 */
function resolveSingBoxBin(): string | null {
  const candidates = [
    process.env.SINGBOX_BIN?.trim(),
    RUNTIME_SINGBOX_PATH,
    "/usr/local/bin/sing-box",
    "/usr/bin/sing-box",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  try {
    const found = execSync("command -v sing-box", { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  return null;
}

/** Where a runtime-downloaded sing-box is cached (writable in the container). */
const RUNTIME_SINGBOX_PATH = path.join(
  process.env.DATA_DIR?.trim() || "/app/data",
  "bin",
  "sing-box",
);

const SINGBOX_DOWNLOAD_VERSION = process.env.SINGBOX_VERSION?.trim() || "1.11.4";

/** Guards against concurrent downloads racing each other. */
let _singBoxInstallPromise: Promise<string | null> | null = null;

/**
 * Ensure a sing-box binary is available, downloading it at runtime if the image
 * shipped without one. This is a safety net for already-deployed images (built
 * before the Dockerfile install was hardened): rather than hard-failing every
 * advanced-proxy task with "sing-box is not installed", we fetch the binary
 * into DATA_DIR (which persists on the mounted volume) on first use.
 *
 * Returns the resolved binary path, or null if it could not be installed
 * (e.g. no network access from the container).
 */
async function ensureSingBox(): Promise<string | null> {
  const existing = resolveSingBoxBin();
  if (existing) return existing;
  if (_singBoxInstallPromise) return _singBoxInstallPromise;

  _singBoxInstallPromise = (async () => {
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
    const version = SINGBOX_DOWNLOAD_VERSION;
    const url =
      `https://github.com/SagerNet/sing-box/releases/download/v${version}/` +
      `sing-box-${version}-linux-${arch}.tar.gz`;
    const dir = path.dirname(RUNTIME_SINGBOX_PATH);
    const tmpTar = path.join(os.tmpdir(), `sing-box-${version}-${arch}.tar.gz`);
    const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), "singbox-dl-"));
    try {
      logger.warn({ url }, "sing-box binary missing — downloading at runtime (one-time)");
      fs.mkdirSync(dir, { recursive: true });
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new Error(`download failed: HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpTar, buf);
      execSync(`tar -xzf ${JSON.stringify(tmpTar)} -C ${JSON.stringify(tmpExtract)}`, { stdio: "ignore" });
      const extractedBin = path.join(tmpExtract, `sing-box-${version}-linux-${arch}`, "sing-box");
      fs.copyFileSync(extractedBin, RUNTIME_SINGBOX_PATH);
      fs.chmodSync(RUNTIME_SINGBOX_PATH, 0o755);
      // Sanity-check the binary runs.
      execSync(`${JSON.stringify(RUNTIME_SINGBOX_PATH)} version`, { stdio: "ignore" });
      logger.info({ path: RUNTIME_SINGBOX_PATH }, "sing-box installed at runtime");
      return RUNTIME_SINGBOX_PATH;
    } catch (err) {
      logger.error({ err }, "Runtime sing-box install failed");
      return null;
    } finally {
      try { fs.rmSync(tmpTar, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  })();

  const result = await _singBoxInstallPromise;
  // Allow a retry on a later call if this attempt failed.
  if (!result) _singBoxInstallPromise = null;
  return result;
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

/**
 * Build a sing-box WebSocket transport, correctly handling the v2ray/xray
 * early-data convention where the path carries `?ed=<n>` (e.g. `/secret?ed=2560`).
 *
 * Real clients (v2rayN / nekoray) split that into `max_early_data` +
 * `early_data_header_name: "Sec-WebSocket-Protocol"`. Our previous parser passed
 * the whole `/secret?ed=2560` through as the literal WS path, so the upstream
 * request-target contained a stray `?ed=2560` and no early-data header — which
 * breaks Cloudflare-Worker WS tunnels that route on an exact path (the node
 * still opened its local SOCKS port, but the outbound never connected, so Chrome
 * failed with ERR_SOCKS_CONNECTION_FAILED). Splitting `ed` out fixes it and
 * matches how the same share link behaves in a normal client.
 */
function buildWsTransport(rawPath: string | null, host: string | null): Record<string, unknown> {
  let wsPath = rawPath || "/";
  const transport: Record<string, unknown> = { type: "ws" };
  const qIdx = wsPath.indexOf("?");
  if (qIdx !== -1) {
    const ed = new URLSearchParams(wsPath.slice(qIdx + 1)).get("ed");
    wsPath = wsPath.slice(0, qIdx) || "/";
    if (ed && /^\d+$/.test(ed)) {
      transport.max_early_data = parseInt(ed, 10);
      transport.early_data_header_name = "Sec-WebSocket-Protocol";
    }
  }
  transport.path = wsPath;
  if (host) transport.headers = { Host: host };
  return transport;
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
    outbound.transport = buildWsTransport(json.path || "/", json.host || null);
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
    outbound.transport = buildWsTransport(params.get("path"), params.get("host"));
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
    outbound.transport = buildWsTransport(params.get("path"), params.get("host"));
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

/** Parse a tuic:// link into a sing-box tuic (v5) outbound. */
function parseTuic(link: string): Record<string, unknown> {
  const u = new URL(link);
  const params = u.searchParams;
  const tls: Record<string, unknown> = {
    enabled: true,
    server_name: params.get("sni") || u.hostname,
    insecure: true,
  };
  // TUIC v5 runs over HTTP/3, so ALPN must include h3 — default it when the
  // share link omits the param (many do).
  const alpn = params.get("alpn");
  tls.alpn = alpn
    ? alpn.split(",").map((s) => s.trim()).filter(Boolean)
    : ["h3"];
  // TUIC carries "uuid:password" in the userinfo. That colon is commonly
  // percent-encoded (%3A), in which case new URL() puts the whole string in
  // username and leaves password empty — so recover both by splitting on the
  // first ':' of the decoded userinfo (a UUID never contains one).
  let uuid = decodeURIComponent(u.username);
  let password = decodeURIComponent(u.password || "");
  if (!password && uuid.includes(":")) {
    const ci = uuid.indexOf(":");
    password = uuid.slice(ci + 1);
    uuid = uuid.slice(0, ci);
  }
  if (!password) password = params.get("password") || "";
  const outbound: Record<string, unknown> = {
    type: "tuic",
    tag: "proxy",
    server: u.hostname,
    server_port: parseInt(u.port || "443", 10),
    uuid,
    password,
    tls,
  };
  const cc = params.get("congestion_control") || params.get("congestion");
  if (cc) outbound.congestion_control = cc;
  const udpRelay = params.get("udp_relay_mode");
  if (udpRelay) outbound.udp_relay_mode = udpRelay;
  return outbound;
}

/**
 * Parse an ss:// (Shadowsocks) link into a sing-box shadowsocks outbound.
 * Handles both the SIP002 form  ss://base64(method:pass)@host:port#tag  (userinfo
 * may also be percent-encoded plaintext for AEAD-2022 methods) and the legacy
 * fully-base64 form  ss://base64(method:pass@host:port)#tag.
 */
function parseSs(link: string): Record<string, unknown> {
  let rest = link.replace(/^ss:\/\//i, "").trim();
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx); // drop the #tag label

  let userinfo: string;
  let hostPart: string;
  const atIdx = rest.lastIndexOf("@");
  if (atIdx !== -1) {
    // SIP002: <userinfo>@host:port[?plugin=…]
    const rawUser = rest.slice(0, atIdx);
    hostPart = rest.slice(atIdx + 1);
    const decodedUser = decodeURIComponent(rawUser);
    // If it already looks like method:password it's plaintext (2022 methods);
    // otherwise it's base64(method:password).
    userinfo = decodedUser.includes(":") ? decodedUser : decodeBase64(rawUser);
  } else {
    // Legacy: entire payload is base64(method:password@host:port)
    const decoded = decodeBase64(rest);
    const at = decoded.lastIndexOf("@");
    userinfo = decoded.slice(0, at);
    hostPart = decoded.slice(at + 1);
  }
  const qIdx = hostPart.indexOf("?");
  if (qIdx !== -1) hostPart = hostPart.slice(0, qIdx); // drop plugin params

  const ci = userinfo.indexOf(":");
  const method = userinfo.slice(0, ci);
  const password = userinfo.slice(ci + 1);
  const portColon = hostPart.lastIndexOf(":");
  const host = hostPart.slice(0, portColon);
  const port = parseInt(hostPart.slice(portColon + 1), 10);

  if (!method || !host || !port) {
    throw new Error("Could not parse ss:// link (method/host/port missing)");
  }
  return {
    type: "shadowsocks",
    tag: "proxy",
    server: host,
    server_port: port,
    method,
    password,
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
    case "tuic":
      return parseTuic(link);
    case "ss":
      return parseSs(link);
    case "warp":
      return parseWarp();
    default:
      throw new Error(
        `buildOutbound: unsupported sing-box proxy type "${type}"`,
      );
  }
}

/**
 * Start a local sing-box that exposes a SOCKS5 inbound on 0.0.0.0 (or a
 * configured bind host) and forwards to the given upstream node. Returns the
 * proxy URL that remote browser containers should use plus a stop().
 */
async function startSingBox(
  type: ProxyType,
  link: string,
  remoteConsumer: boolean,
): Promise<ResolvedProxy> {
  const outbound = buildOutbound(type, link);
  const singBoxBin = await ensureSingBox();
  if (!singBoxBin) {
    throw new Error(
      `Proxy type "${type}" needs the sing-box binary, which is not installed on this host and ` +
        `could not be downloaded automatically (no network access, or the release is unavailable). ` +
        `Install it (https://sing-box.sagernet.org), set SINGBOX_BIN to its path, or use an http/socks5 proxy instead.`,
    );
  }
  const port = await getFreePort();
  const listenHost = getSingBoxListenHost();
  const config = {
    log: { level: "warn" },
    inbounds: [
      { type: "socks", tag: "in", listen: listenHost, listen_port: port },
    ],
    outbounds: [outbound, { type: "direct", tag: "direct" }],
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "singbox-"));
  const cfgFile = path.join(dir, "config.json");
  const logFile = path.join(dir, "stderr.log");
  fs.writeFileSync(cfgFile, JSON.stringify(config));

  const child = spawn(singBoxBin, ["run", "-c", cfgFile], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = fs.createWriteStream(logFile, { flags: "a" });
  child.stderr?.pipe(stderr);
  child.on("error", (err) => logger.error({ err }, "sing-box process error"));

  const cleanup = async () => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    await new Promise<void>((resolve) => stderr.end(() => resolve()));
  };

  try {
    await waitForPort(port);
  } catch (err) {
    await cleanup();
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim() : "";
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `sing-box started for proxy type "${type}" but did not open the SOCKS port on ${listenHost}:${port}. ` +
        (logText ? `sing-box stderr: ${logText}` : `Last error: ${(err as Error).message}`),
    );
  }

  const candidates = remoteConsumer
    ? Array.from(new Set([
        process.env.SINGBOX_PROXY_PUBLIC_HOST?.trim(),
        process.env.PROXY_PUBLIC_HOST?.trim(),
        "app",
        detectReachableIPv4(),
        "127.0.0.1",
      ].filter((v): v is string => !!v && v.length > 0)))
    : ["127.0.0.1"];

  let publicHost = "127.0.0.1";
  for (const candidate of candidates) {
    if (await canConnectToHost(candidate, port)) {
      publicHost = candidate;
      break;
    }
  }

  logger.info({ type, listenHost, publicHost, localPort: port }, "Local sing-box proxy started");

  return {
    serverUrl: `socks5://${publicHost}:${port}`,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        stderr.end();
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
 * sing-box helper and returns the SOCKS5 URL.
 *
 * `remoteConsumer` tells us whether the browser that will use this proxy lives
 * in a separate container (browserless / cf-proxy / remote CDP). When true, the
 * returned URL advertises a cross-container-reachable address instead of
 * 127.0.0.1, and the sing-box inbound binds to all interfaces.
 *
 * Returns null when no proxy is configured.
 */
export async function startLocalProxy(
  cfg: ProxyConfig,
  remoteConsumer = false,
): Promise<ResolvedProxy | null> {
  const type = resolveProxyType(cfg);
  if (!type) return null;

  const url = (cfg.proxyUrl ?? "").trim();

  // A proxy *type* by itself is not enough to mean "use a proxy". The UI keeps
  // a default proxyType (usually "http") even when the address field is blank;
  // treating that as an active proxy makes providers do unnecessary proxy
  // resolution and, for WARP, can accidentally start sing-box for every task.
  if (!url) {
    const warpConfigPath = process.env.WARP_CONFIG_PATH?.trim();
    if (type === "warp" && warpConfigPath) {
      return startSingBox(type, url, remoteConsumer);
    }
    logger.warn(
      { proxyType: type },
      "Ignoring proxy type without proxy URL; no browser proxy will be used",
    );
    return null;
  }

  // Passthrough: Chromium speaks http/socks directly.
  if (type === "http" || type === "socks5") {
    return { serverUrl: url, stop: async () => {} };
  }

  return startSingBox(type, url, remoteConsumer);
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
  tuic: "TUIC",
  ss: "Shadowsocks",
};
