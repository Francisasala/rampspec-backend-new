export type DependencyName = "database" | "objectStore" | "scheduler" | "signing" | (string & {});

export interface ComponentReadiness {
  readonly ready: boolean;
  readonly status: "ready" | "not_ready";
}

export interface ReadinessResult {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly components: Readonly<Record<string, ComponentReadiness>>;
  readonly status: "ready" | "not_ready";
}

export interface HealthCheck {
  readonly check: () => Promise<boolean>;
  readonly name: string;
  readonly timeoutMs?: number;
}

export interface StandardReadinessChecks {
  readonly database: () => Promise<boolean>;
  readonly objectStore: () => Promise<boolean>;
  readonly scheduler: () => Promise<boolean>;
  readonly signing: () => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 5000;

function executeBoundedCheck(
  check: () => Promise<boolean>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);

    Promise.resolve()
      .then(() => check())
      .then(
        (res) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(Boolean(res));
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        },
      );
  });
}

export async function readiness(
  checks: readonly HealthCheck[],
  options: { readonly timeoutMs?: number } = {},
): Promise<ReadinessResult> {
  const checksMap: Record<string, boolean> = {};
  const componentsMap: Record<string, ComponentReadiness> = {};

  await Promise.all(
    checks.map(async (check) => {
      const timeout = check.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const isReady = await executeBoundedCheck(check.check, timeout);
      checksMap[check.name] = isReady;
      componentsMap[check.name] = {
        ready: isReady,
        status: isReady ? "ready" : "not_ready",
      };
    }),
  );

  const isAllReady = Object.values(checksMap).length > 0 && Object.values(checksMap).every(Boolean);

  return {
    checks: checksMap,
    components: componentsMap,
    status: isAllReady ? "ready" : "not_ready",
  };
}

export async function checkStandardReadiness(
  checks: StandardReadinessChecks,
  options: { readonly timeoutMs?: number } = {},
): Promise<ReadinessResult> {
  const healthChecks: HealthCheck[] = [
    { check: checks.database, name: "database" },
    { check: checks.objectStore, name: "objectStore" },
    { check: checks.scheduler, name: "scheduler" },
    { check: checks.signing, name: "signing" },
  ];
  return readiness(healthChecks, options);
}

export function liveness(): { readonly status: "ok" } {
  return { status: "ok" };
}

export type WorkerState = "healthy" | "delayed" | "offline";

export interface WorkerHeartbeatConfig {
  readonly delayedThresholdMs?: number;
  readonly offlineThresholdMs?: number;
  readonly maxClockSkewMs?: number;
  readonly clock?: () => number;
}

export interface WorkerStatus {
  readonly workerId: string;
  readonly lastHeartbeat: number;
  readonly state: WorkerState;
  readonly isAssignable: boolean;
  readonly elapsedMs: number;
}

export class WorkerHeartbeatTracker {
  private readonly workers = new Map<string, number>();
  private readonly delayedThresholdMs: number;
  private readonly offlineThresholdMs: number;
  private readonly maxClockSkewMs: number;
  private readonly clock: () => number;

  constructor(config: WorkerHeartbeatConfig = {}) {
    this.delayedThresholdMs = config.delayedThresholdMs ?? 10_000;
    this.offlineThresholdMs = config.offlineThresholdMs ?? 30_000;
    this.maxClockSkewMs = config.maxClockSkewMs ?? 5_000;
    this.clock = config.clock ?? (() => Date.now());
    if (this.delayedThresholdMs <= 0 || this.offlineThresholdMs <= this.delayedThresholdMs) {
      throw new Error("Invalid timeout thresholds: offlineThresholdMs must exceed delayedThresholdMs > 0.");
    }
  }

  recordHeartbeat(workerId: string, timestamp?: number): void {
    if (!workerId || typeof workerId !== "string" || workerId.trim().length === 0) {
      throw new Error("Worker ID must be a non-empty string.");
    }
    const now = this.clock();
    const heartbeat = timestamp ?? now;
    if (!Number.isFinite(heartbeat)) throw new Error("Invalid heartbeat timestamp.");
    if (heartbeat > now + this.maxClockSkewMs) {
      throw new Error("Heartbeat timestamp exceeds acceptable clock skew.");
    }
    const existing = this.workers.get(workerId);
    if (existing !== undefined && heartbeat < existing) return;
    this.workers.set(workerId, Math.min(heartbeat, now));
  }

  getWorkerStatus(workerId: string): WorkerStatus {
    const lastHeartbeat = this.workers.get(workerId);
    const now = this.clock();
    if (lastHeartbeat === undefined) {
      return Object.freeze({
        elapsedMs: Number.POSITIVE_INFINITY,
        isAssignable: false,
        lastHeartbeat: 0,
        state: "offline" as const,
        workerId,
      });
    }
    const elapsedMs = Math.max(0, now - lastHeartbeat);
    const state: WorkerState = elapsedMs >= this.offlineThresholdMs
      ? "offline"
      : elapsedMs >= this.delayedThresholdMs
        ? "delayed"
        : "healthy";
    return Object.freeze({
      elapsedMs,
      isAssignable: state !== "offline",
      lastHeartbeat,
      state,
      workerId,
    });
  }

  canAssignWork(workerId: string): boolean {
    return this.getWorkerStatus(workerId).isAssignable;
  }

  getOperationalMetrics(): {
    readonly totalTracked: number;
    readonly healthy: number;
    readonly delayed: number;
    readonly offline: number;
  } {
    let healthy = 0;
    let delayed = 0;
    let offline = 0;
    for (const workerId of this.workers.keys()) {
      const state = this.getWorkerStatus(workerId).state;
      if (state === "healthy") healthy += 1;
      else if (state === "delayed") delayed += 1;
      else offline += 1;
    }
    return Object.freeze({ delayed, healthy, offline, totalTracked: this.workers.size });
  }

  removeWorker(workerId: string): boolean {
    return this.workers.delete(workerId);
  }
}
