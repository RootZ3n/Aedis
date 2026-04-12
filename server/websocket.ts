/**
 * WebSocket event bus — Live event streaming for Aedis.
 *
 * The EventBus is the central nervous system for real-time updates.
 * The Coordinator emits events as the build progresses; connected
 * clients receive them over WebSocket. Every event type maps to a
 * specific phase in the build lifecycle.
 */

import type { WebSocket } from "ws";

// ─── Event Types ─────────────────────────────────────────────────────

export interface AedisEvent {
  type: AedisEventType;
  payload: Record<string, unknown>;
}

/**
 * @deprecated Use AedisEvent. Retained as a type alias for source-level
 * back-compat during the rename cleanup; will be removed in a later
 * release.
 */
export type ZendoriumEvent = AedisEvent;

export type AedisEventType =
  | "run_started"
  | "charter_generated"
  | "intent_locked"
  | "task_graph_built"
  | "coherence_check_started"
  | "coherence_check_passed"
  | "coherence_check_failed"
  | "task_started"
  | "worker_assigned"
  | "scout_complete"
  | "builder_complete"
  | "critic_review"
  | "verifier_check"
  | "task_complete"
  | "task_failed"
  | "recovery_attempted"
  | "escalation_triggered"
  | "integration_check"
  | "merge_approved"
  | "merge_blocked"
  | "commit_created"
  | "run_cancelled"
  | "run_complete"
  | "run_receipt"
  | "system_event"
  | "config_event"
  | "execution_verified"
  | "execution_failed"
  | "blast_radius_estimated"
  | "run_summary";

/**
 * @deprecated Use AedisEventType. Alias kept for downstream code that
 * still imports the old name while we finish the Zendorium → Aedis
 * rename.
 */
export type ZendoriumEventType = AedisEventType;

// ─── Wire Protocol ───────────────────────────────────────────────────

export interface WireMessage {
  /** Event type */
  type: AedisEventType;
  /** Event payload */
  payload: Record<string, unknown>;
  /** ISO timestamp */
  timestamp: string;
  /** Monotonically increasing sequence number per connection */
  seq: number;
}

// ─── Event Bus ───────────────────────────────────────────────────────

export type EventListener = (event: AedisEvent) => void;

export interface EventBus {
  /** Emit an event to all listeners and connected WebSocket clients */
  emit(event: AedisEvent): void;
  /** Register a listener for all events */
  on(listener: EventListener): () => void;
  /** Register a listener for a specific event type */
  onType(type: AedisEventType, listener: EventListener): () => void;
  /** Register a WebSocket client for live streaming */
  addClient(ws: WebSocket, filter?: AedisEventType[]): void;
  /** Remove a WebSocket client */
  removeClient(ws: WebSocket): void;
  /** Get count of connected clients */
  clientCount(): number;
  /** Get recent event history (for late-joining clients) */
  recentEvents(limit?: number): WireMessage[];
}

// ─── Implementation ──────────────────────────────────────────────────

interface ClientEntry {
  ws: WebSocket;
  filter: Set<AedisEventType> | null; // null = all events
  seq: number;
}

export function createEventBus(historySize: number = 100): EventBus {
  const listeners: EventListener[] = [];
  const typeListeners = new Map<AedisEventType, EventListener[]>();
  const clients = new Map<WebSocket, ClientEntry>();
  const history: WireMessage[] = [];
  let globalSeq = 0;

  function emit(event: AedisEvent): void {
    globalSeq++;

    const wire: WireMessage = {
      type: event.type,
      payload: event.payload,
      timestamp: new Date().toISOString(),
      seq: globalSeq,
    };

    // Store in history ring buffer
    history.push(wire);
    if (history.length > historySize) {
      history.shift();
    }

    // Notify in-process listeners
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors don't break the bus
      }
    }

    // Notify type-specific listeners
    const typed = typeListeners.get(event.type);
    if (typed) {
      for (const listener of typed) {
        try {
          listener(event);
        } catch {
          // Listener errors don't break the bus
        }
      }
    }

    // Push to WebSocket clients
    const message = JSON.stringify(wire);
    for (const [ws, entry] of clients) {
      if (entry.filter && !entry.filter.has(event.type)) continue;

      try {
        if (ws.readyState === 1 /* WebSocket.OPEN */) {
          entry.seq++;
          ws.send(message);
        }
      } catch {
        // Dead socket — will be cleaned up on close
      }
    }
  }

  function on(listener: EventListener): () => void {
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  function onType(type: AedisEventType, listener: EventListener): () => void {
    const existing = typeListeners.get(type) ?? [];
    existing.push(listener);
    typeListeners.set(type, existing);
    return () => {
      const arr = typeListeners.get(type);
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  function addClient(ws: WebSocket, filter?: AedisEventType[]): void {
    clients.set(ws, {
      ws,
      filter: filter ? new Set(filter) : null,
      seq: 0,
    });

    // Send recent history as catchup
    const catchup = recentEvents(20);
    for (const msg of catchup) {
      if (filter && !filter.includes(msg.type)) continue;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        break;
      }
    }
  }

  function removeClient(ws: WebSocket): void {
    clients.delete(ws);
  }

  function clientCount(): number {
    return clients.size;
  }

  function recentEvents(limit: number = 50): WireMessage[] {
    return history.slice(-limit);
  }

  return { emit, on, onType, addClient, removeClient, clientCount, recentEvents };
}
