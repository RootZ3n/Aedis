/**
 * Session store — persists AedisSession to data/sessions/<id>.json.
 * One file per session. Written after every cycle for crash resilience.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { AedisSession, CycleResult, CycleError, StopDecision } from "../types/session.js";

const SESSIONS_DIR = "data/sessions";

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

// ─── Init ─────────────────────────────────────────────────────────────

export async function ensureSessionsDir(): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────

export async function createSession(session: AedisSession): Promise<void> {
  await ensureSessionsDir();
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export async function loadSession(id: string): Promise<AedisSession | null> {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as AedisSession;
}

export async function saveSession(session: AedisSession): Promise<void> {
  session.updatedAt = Date.now();
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

// ─── Cycle history ────────────────────────────────────────────────────

export async function appendCycleResult(
  sessionId: string,
  result: CycleResult
): Promise<void> {
  const session = await loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  session.cycleHistory.push(result);
  session.lastError = result.error;
  session.updatedAt = Date.now();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf8");
}

// ─── Status transitions ──────────────────────────────────────────────

export async function transitionSession(
  sessionId: string,
  status: AedisSession["status"],
  terminalReason: string | null
): Promise<AedisSession> {
  const session = await loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  session.status = status;
  session.terminalReason = terminalReason;
  session.updatedAt = Date.now();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf8");
  return session;
}

// ─── All session list ───────────────────────────────────────────────

export async function listAllSessions(): Promise<AedisSession[]> {
  await ensureSessionsDir();
  const { readdirSync } = await import("fs");
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  const sessions: AedisSession[] = [];
  for (const file of files) {
    const raw = await readFile(join(SESSIONS_DIR, file), "utf8");
    sessions.push(JSON.parse(raw) as AedisSession);
  }
  return sessions;
}

// ─── Active session list ───────────────────────────────────────────────

export async function listActiveSessions(): Promise<AedisSession[]> {
  const all = await listAllSessions();
  return all.filter(s => s.status === "active");
}
