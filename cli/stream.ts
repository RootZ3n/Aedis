#!/usr/bin/env node

type WorkerRole = "scout" | "builder" | "critic" | "verifier" | "integrator";

type StreamReceipt = {
  id: string;
  kind: string;
  worker: string;
  summary: string;
  costUsd: number;
  at: string;
};

type StreamNode = {
  id: string;
  label: string;
  status: string;
  workerType: string;
};

type StreamState = {
  runId: string | null;
  status: string;
  prompt: string;
  totalCostUsd: number;
  receipts: StreamReceipt[];
  graph: { nodes: StreamNode[]; edges: Array<{ from: string; to: string }> };
  workers: Record<WorkerRole, { status: string; model: string; currentTask: string }>;
  coherence: Array<{ name: string; passed: boolean; message: string }>;
  mergeApproval: { status: string; reason: string };
};

const color = {
  reset: "\u001b[0m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  gray: "\u001b[90m",
  bold: "\u001b[1m",
};

const roleOrder: WorkerRole[] = ["scout", "builder", "critic", "verifier", "integrator"];
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TerminalStream {
  private state: StreamState;
  private spinnerIndex = 0;

  constructor() {
    this.state = {
      runId: null,
      status: "idle",
      prompt: "",
      totalCostUsd: 0,
      receipts: [],
      graph: { nodes: [], edges: [] },
      workers: {
        scout: { status: "idle", model: "unassigned", currentTask: "Waiting" },
        builder: { status: "idle", model: "unassigned", currentTask: "Waiting" },
        critic: { status: "idle", model: "unassigned", currentTask: "Waiting" },
        verifier: { status: "idle", model: "unassigned", currentTask: "Waiting" },
        integrator: { status: "idle", model: "unassigned", currentTask: "Waiting" },
      },
      coherence: [],
      mergeApproval: { status: "pending", reason: "No merge decision yet." },
    };
  }

  ingest(event: Record<string, unknown>): void {
    const type = String(event.type || event.event || event.kind || "log").toLowerCase();
    this.state.runId = String(event.runId || event.run_id || this.state.runId || "").trim() || this.state.runId;
    this.state.prompt = String(event.prompt || event.input || event.request || this.state.prompt || "");
    if (event.status) this.state.status = String(event.status);

    if (Array.isArray(event.receipts)) {
      this.state.receipts = (event.receipts as Record<string, unknown>[]).map((receipt) => this.normalizeReceipt(receipt));
      this.state.totalCostUsd = this.state.receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0);
    }

    if (type.includes("receipt")) {
      const receipt = this.normalizeReceipt((event.receipt as Record<string, unknown>) || event);
      this.state.receipts.unshift(receipt);
      this.state.receipts = this.state.receipts.slice(0, 20);
      this.state.totalCostUsd += receipt.costUsd;
    }

    if (event.totalCostUsd != null || event.total_cost_usd != null) {
      this.state.totalCostUsd = Number(event.totalCostUsd ?? event.total_cost_usd ?? this.state.totalCostUsd);
    }

    if (event.graph || event.taskGraph || event.task_graph) {
      this.state.graph = this.normalizeGraph((event.graph || event.taskGraph || event.task_graph) as Record<string, unknown>);
    }
    if (event.task || event.node) {
      this.mergeNode(((event.task || event.node) as Record<string, unknown>), type);
    }

    if (Array.isArray(event.workers)) {
      for (const worker of event.workers as Record<string, unknown>[]) this.applyWorker(worker);
    }
    if (event.worker || event.workerStatus || event.worker_status) {
      this.applyWorker((event.worker || event.workerStatus || event.worker_status) as Record<string, unknown>);
    }

    if (Array.isArray(event.coherenceChecks || event.coherence_checks)) {
      this.state.coherence = ((event.coherenceChecks || event.coherence_checks) as Record<string, unknown>[]).map((item) => ({
        name: String(item.name || item.label || "Check"),
        passed: Boolean(item.passed ?? item.ok),
        message: String(item.message || item.details || ""),
      }));
    }

    if (event.mergeApproval || event.merge_approval || event.approval) {
      const approval = (event.mergeApproval || event.merge_approval || event.approval) as Record<string, unknown>;
      this.state.mergeApproval = {
        status: String(approval.status || approval.state || "pending"),
        reason: String(approval.reason || approval.message || "Awaiting integrator decision."),
      };
    }

    if (type.includes("complete") || type === "done") {
      this.state.status = "complete";
    } else if (type.includes("error") || type.includes("fail")) {
      this.state.status = "failed";
    } else if (type.includes("start") || type.includes("run")) {
      this.state.status = "running";
    }

    this.render();
  }

  renderHeader(): string {
    const statusColor = this.state.status === "complete"
      ? color.green
      : this.state.status === "failed"
        ? color.red
        : color.blue;
    return [
      `${color.bold}${color.cyan}Zendorium${color.reset} ${statusColor}${this.state.status.toUpperCase()}${color.reset}`,
      `${color.gray}Run:${color.reset} ${this.state.runId || "pending"}`,
      `${color.gray}Cost:${color.reset} ${color.yellow}$${this.state.totalCostUsd.toFixed(4)}${color.reset}`,
      this.state.prompt ? `${color.gray}Prompt:${color.reset} ${this.state.prompt}` : null,
    ].filter(Boolean).join("\n");
  }

  renderWorkers(): string {
    const frame = spinnerFrames[this.spinnerIndex++ % spinnerFrames.length];
    return roleOrder.map((role) => {
      const worker = this.state.workers[role];
      const active = /active|running|busy|assigned/.test(worker.status);
      const tone = worker.status === "failed" ? color.red : worker.status === "complete" ? color.green : active ? color.blue : color.gray;
      const prefix = active ? `${frame}` : "•";
      return `${tone}${prefix}${color.reset} ${role.padEnd(10)} ${worker.status.padEnd(10)} ${worker.model.padEnd(18)} ${worker.currentTask}`;
    }).join("\n");
  }

  renderGraph(): string {
    const nodes = this.state.graph.nodes;
    if (!nodes.length) return `${color.gray}No task graph yet.${color.reset}`;
    return nodes.map((node) => {
      const tone = node.status === "completed"
        ? color.green
        : node.status === "failed"
          ? color.red
          : /active|running|ready/.test(node.status)
            ? color.blue
            : color.gray;
      const marker = node.status === "completed" ? "[x]" : node.status === "failed" ? "[!]" : /active|running|ready/.test(node.status) ? "[>]" : "[ ]";
      return `${tone}${marker}${color.reset} ${node.label} ${color.gray}(${node.workerType}/${node.status})${color.reset}`;
    }).join("\n");
  }

  renderReceipts(): string {
    if (!this.state.receipts.length) return `${color.gray}No receipts yet.${color.reset}`;
    return this.state.receipts.slice(0, 8).map((receipt) => {
      return `${color.magenta}${receipt.kind}${color.reset} ${receipt.summary} ${color.gray}${receipt.worker}${color.reset} ${color.yellow}$${receipt.costUsd.toFixed(4)}${color.reset}`;
    }).join("\n");
  }

  renderCoherence(): string {
    if (!this.state.coherence.length) return `${color.gray}No coherence checks yet.${color.reset}`;
    return this.state.coherence.map((item) => {
      const tone = item.passed ? color.green : color.red;
      return `${tone}${item.passed ? "PASS" : "FAIL"}${color.reset} ${item.name} ${color.gray}${item.message}${color.reset}`;
    }).join("\n");
  }

  renderApproval(): string {
    const tone = this.state.mergeApproval.status === "approved"
      ? color.green
      : this.state.mergeApproval.status === "blocked"
        ? color.red
        : color.yellow;
    return `${tone}${this.state.mergeApproval.status.toUpperCase()}${color.reset} ${this.state.mergeApproval.reason}`;
  }

  render(): void {
    const output = [
      this.renderHeader(),
      "",
      `${color.bold}Workers${color.reset}`,
      this.renderWorkers(),
      "",
      `${color.bold}Task Graph${color.reset}`,
      this.renderGraph(),
      "",
      `${color.bold}Receipts${color.reset}`,
      this.renderReceipts(),
      "",
      `${color.bold}Coherence${color.reset}`,
      this.renderCoherence(),
      "",
      `${color.bold}Merge Approval${color.reset}`,
      this.renderApproval(),
    ].join("\n");

    process.stdout.write("\u001bc");
    process.stdout.write(output + "\n");
  }

  renderFinalSummary(): string {
    return [
      `${color.bold}Final Summary${color.reset}`,
      `${color.gray}Run:${color.reset} ${this.state.runId || "unknown"}`,
      `${color.gray}Status:${color.reset} ${this.state.status}`,
      `${color.gray}Cost:${color.reset} $${this.state.totalCostUsd.toFixed(4)}`,
      `${color.gray}Receipts:${color.reset} ${this.state.receipts.length}`,
      `${color.gray}Merge:${color.reset} ${this.state.mergeApproval.status}`,
    ].join("\n");
  }

  private normalizeReceipt(receipt: Record<string, unknown>): StreamReceipt {
    return {
      id: String(receipt.id || receipt.receiptId || receipt.receipt_id || `receipt-${Date.now()}`),
      kind: String(receipt.kind || receipt.type || "receipt"),
      worker: String(receipt.worker || receipt.workerType || receipt.worker_type || "system"),
      summary: String(receipt.summary || receipt.message || receipt.detail || "Receipt recorded."),
      costUsd: Number(receipt.costUsd ?? receipt.cost_usd ?? receipt.cost ?? 0),
      at: String(receipt.at || receipt.timestamp || new Date().toISOString()),
    };
  }

  private normalizeGraph(graph: Record<string, unknown>): { nodes: StreamNode[]; edges: Array<{ from: string; to: string }> } {
    const nodes = Array.isArray(graph.nodes) ? (graph.nodes as Record<string, unknown>[]).map((node) => ({
      id: String(node.id || node.taskId || node.task_id || node.label || `node-${Date.now()}`),
      label: String(node.label || node.description || node.title || node.id || "task"),
      status: String(node.status || "planned"),
      workerType: String(node.workerType || node.worker_type || this.inferWorkerType(String(node.label || node.id || "builder"))),
    })) : [];

    const edges = Array.isArray(graph.edges) ? (graph.edges as Record<string, unknown>[]).map((edge) => ({
      from: String(edge.from || edge.source),
      to: String(edge.to || edge.target),
    })) : [];

    return { nodes, edges };
  }

  private mergeNode(node: Record<string, unknown>, eventType: string): void {
    const id = String(node.id || node.taskId || node.task_id || node.label || `node-${Date.now()}`);
    const existing = this.state.graph.nodes.find((entry) => entry.id === id);
    const next: StreamNode = {
      id,
      label: String(node.label || node.description || node.title || id),
      status: String(node.status || this.statusFromEvent(eventType)),
      workerType: String(node.workerType || node.worker_type || this.inferWorkerType(String(node.label || node.description || id))),
    };
    if (existing) Object.assign(existing, next);
    else this.state.graph.nodes.push(next);
  }

  private applyWorker(worker: Record<string, unknown>): void {
    const role = String(worker.role || worker.workerType || worker.worker_type || this.inferWorkerType(String(worker.name || ""))).toLowerCase() as WorkerRole;
    if (!roleOrder.includes(role)) return;
    this.state.workers[role] = {
      status: String(worker.status || "idle"),
      model: String(worker.model || worker.assignedModel || worker.assigned_model || "unassigned"),
      currentTask: String(worker.currentTask || worker.task || worker.current_task || "Waiting"),
    };
  }

  private inferWorkerType(text: string): WorkerRole {
    const lower = text.toLowerCase();
    if (lower.includes("scout")) return "scout";
    if (lower.includes("critic")) return "critic";
    if (lower.includes("verify")) return "verifier";
    if (lower.includes("integrat") || lower.includes("merge")) return "integrator";
    return "builder";
  }

  private statusFromEvent(type: string): string {
    if (type.includes("complete") || type.includes("done")) return "completed";
    if (type.includes("error") || type.includes("fail")) return "failed";
    if (type.includes("active") || type.includes("start") || type.includes("dispatch") || type.includes("run")) return "active";
    return "planned";
  }
}

export async function streamSocket(
  socket: WebSocket,
  stream: TerminalStream,
  opts: { request?: Record<string, unknown>; closeOnComplete?: boolean; taskId?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    socket.addEventListener("open", () => {
      if (opts.request) {
        socket.send(JSON.stringify(opts.request));
      }
    });

    socket.addEventListener("message", (event) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        payload = { type: "log", message: String(event.data) };
      }

      // If taskId filter is set, only ingest events matching this task
      if (opts.taskId) {
        const eventTaskId = payload.taskId || payload.task_id || (payload.payload as any)?.taskId;
        const eventRunId = payload.runId || payload.run_id || (payload.payload as any)?.runId;
        // Accept events that match our taskId, or have no taskId (system events)
        if (eventTaskId && eventTaskId !== opts.taskId && eventRunId && eventRunId !== opts.taskId) {
          return; // skip events from other runs
        }
      }

      stream.ingest(payload);
      const type = String(payload.type || payload.event || payload.kind || "").toLowerCase();
      if (opts.closeOnComplete && (type.includes("complete") || type === "done" || type.includes("failed") || type.includes("error"))) {
        socket.close();
      }
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        process.stdout.write("\n" + stream.renderFinalSummary() + "\n");
        resolve();
      }
    });

    socket.addEventListener("error", (event) => {
      if (!settled) {
        settled = true;
        // ErrorEvent.message contains the actual error string.
        // Falling back through possible shapes since the global WebSocket
        // and ws library emit different error event types.
        const msg =
          (event as any).message ??
          (event as any).error?.message ??
          (event as any).error ??
          "WebSocket connection failed (is the server running?)";
        reject(new Error(String(msg)));
      }
    });
  });
}
