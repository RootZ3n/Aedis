/**
 * Tailscale auth middleware — Zendorium access control.
 *
 * Only accepts connections from Tailscale IP range (100.x.x.x).
 * All rejected attempts are logged with source IP and timestamp.
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";

// ─── Types ───────────────────────────────────────────────────────────

export interface AuthConfig {
  /** Enable or disable auth (disable for local dev) */
  enabled: boolean;
  /** Additional allowed CIDRs beyond Tailscale */
  allowedCidrs: string[];
  /** Log rejected attempts */
  logRejections: boolean;
}

const DEFAULT_CONFIG: AuthConfig = {
  enabled: true,
  allowedCidrs: [],
  logRejections: true,
};

// ─── Tailscale IP Check ──────────────────────────────────────────────

const TAILSCALE_PREFIX = "100.";

function isTailscaleIp(ip: string): boolean {
  // Tailscale CGNAT range: 100.64.0.0/10 (100.64.x.x - 100.127.x.x)
  // In practice, Tailscale assigns from the full 100.x.x.x range
  if (!ip.startsWith(TAILSCALE_PREFIX)) return false;

  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  return parts.every((p) => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255;
  });
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function matchesCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split("/");
  if (!network || !prefixStr) return ip === cidr;

  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix)) return false;

  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(network);
  if (ipNum === null || netNum === null) return false;

  const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function ipToNumber(ip: string): number | null {
  // Strip IPv6 prefix
  const clean = ip.replace(/^::ffff:/, "");
  const parts = clean.split(".");
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

// ─── Extract Client IP ──────────────────────────────────────────────

function getClientIp(request: FastifyRequest): string {
  // Check X-Forwarded-For first (reverse proxy)
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }

  // Check X-Real-IP
  const realIp = request.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  // Fall back to socket address
  return request.ip;
}

// ─── Middleware Factory ──────────────────────────────────────────────

export function createTailscaleAuth(config: Partial<AuthConfig> = {}) {
  const cfg: AuthConfig = { ...DEFAULT_CONFIG, ...config };

  return function tailscaleAuth(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    if (!cfg.enabled) {
      done();
      return;
    }

    const clientIp = getClientIp(request);

    // Allow loopback
    if (isLoopback(clientIp)) {
      done();
      return;
    }

    // Allow Tailscale IPs
    if (isTailscaleIp(clientIp)) {
      done();
      return;
    }

    // Check additional allowed CIDRs
    for (const cidr of cfg.allowedCidrs) {
      if (matchesCidr(clientIp, cidr)) {
        done();
        return;
      }
    }

    // Rejected
    if (cfg.logRejections) {
      const log = request.log ?? console;
      log.warn({
        msg: "Rejected non-Tailscale connection",
        ip: clientIp,
        method: request.method,
        url: request.url,
        timestamp: new Date().toISOString(),
      });
    }

    reply
      .code(403)
      .header("Content-Type", "application/json")
      .send({
        error: "Forbidden",
        message: "Access restricted to Tailscale network",
      });
  };
}
