export const HOSTED_DISPATCH_LIMIT = 8;
export const HOSTED_DEADLINE_MS = 15 * 60 * 1_000;

type GuardStopReason =
  | "external-failure"
  | "cancelled"
  | "deadline"
  | "dispatch-limit"
  | "overlap"
  | "endpoint-blocked"
  | "disposed";

export type HostedDispatchGuardState = "waiting" | "ready" | GuardStopReason;

export type HostedDispatchGuardErrorCode = "not-ready" | GuardStopReason;

export class HostedDispatchGuardError extends Error {
  readonly code: HostedDispatchGuardErrorCode;

  constructor(code: HostedDispatchGuardErrorCode) {
    super(`Hosted qualification dispatch guard stopped: ${code}`);
    this.name = "HostedDispatchGuardError";
    this.code = code;
  }
}

export interface HostedDispatchGuardSnapshot {
  readonly state: HostedDispatchGuardState;
  readonly dispatches: number;
  readonly maxDispatches: number;
  readonly deadlineMs: number;
  readonly readyAtMs?: number;
  readonly deadlineAtMs?: number;
  readonly inFlight: boolean;
}

export interface HostedDispatchGuardOptions {
  /** Required: no default/global fetch is used by this isolated qualification helper. */
  fetch: typeof globalThis.fetch;
  /** Required allowlist; the guard never forwards an endpoint outside it. */
  allowedEndpoint: (url: URL) => boolean;
  signal?: AbortSignal;
  maxDispatches?: number;
  deadlineMs?: number;
  now?: () => number;
}

/**
 * Qualification-only dispatch boundary. It is deliberately kept under test/support and is never
 * imported by normal extension runtime code. Count increments immediately before each actual fetch,
 * not when a caller starts a logical compaction operation.
 */
export class HostedDispatchGuard {
  private readonly baseFetch: typeof globalThis.fetch;
  private readonly allowedEndpoint: (url: URL) => boolean;
  private readonly parentSignal?: AbortSignal;
  private readonly maxDispatches: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private state: HostedDispatchGuardState = "waiting";
  private dispatches = 0;
  private readyAtMs?: number;
  private deadlineAtMs?: number;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private parentAbortListener?: () => void;
  private inFlight = false;
  private disposed = false;

  readonly fetch: typeof globalThis.fetch;

  constructor(options: HostedDispatchGuardOptions) {
    if (!Number.isSafeInteger(options.maxDispatches ?? HOSTED_DISPATCH_LIMIT)) {
      throw new RangeError("Hosted dispatch limit must be an integer");
    }
    const maxDispatches = options.maxDispatches ?? HOSTED_DISPATCH_LIMIT;
    if (maxDispatches < 1 || maxDispatches > HOSTED_DISPATCH_LIMIT) {
      throw new RangeError("Hosted dispatch limit must be between 1 and 8");
    }
    if (!Number.isSafeInteger(options.deadlineMs ?? HOSTED_DEADLINE_MS)) {
      throw new RangeError("Hosted deadline must be an integer number of milliseconds");
    }
    const deadlineMs = options.deadlineMs ?? HOSTED_DEADLINE_MS;
    if (deadlineMs < 1 || deadlineMs > HOSTED_DEADLINE_MS) {
      throw new RangeError("Hosted deadline must be between 1 ms and 15 minutes");
    }
    this.baseFetch = options.fetch;
    this.allowedEndpoint = options.allowedEndpoint;
    this.parentSignal = options.signal;
    this.maxDispatches = maxDispatches;
    this.deadlineMs = deadlineMs;
    this.now = options.now ?? (() => performance.now());
    this.fetch = (input, init) => this.dispatch(input, init);

    if (this.parentSignal?.aborted) {
      this.stop("cancelled", false);
    } else if (this.parentSignal) {
      this.parentAbortListener = () => this.stop("cancelled", true);
      this.parentSignal.addEventListener("abort", this.parentAbortListener, { once: true });
    }
  }

  /** Starts the wall-clock deadline only after the caller's readiness handshake succeeds. */
  markReady(): void {
    if (this.state !== "waiting") throw this.errorForCurrentState();
    if (this.parentSignal?.aborted) {
      this.stop("cancelled", false);
      throw this.errorForCurrentState();
    }
    this.state = "ready";
    this.readyAtMs = this.now();
    this.deadlineAtMs = this.readyAtMs + this.deadlineMs;
    this.deadlineTimer = setTimeout(() => this.stop("deadline", true), this.deadlineMs);
  }

  /** Seal the run after an external response fails protocol validation outside fetch. */
  stopAfterExternalFailure(): void {
    if (this.state === "ready" || this.state === "waiting") this.stop("external-failure", false);
  }

  snapshot(): HostedDispatchGuardSnapshot {
    return Object.freeze({
      state: this.state,
      dispatches: this.dispatches,
      maxDispatches: this.maxDispatches,
      deadlineMs: this.deadlineMs,
      ...(this.readyAtMs === undefined ? {} : { readyAtMs: this.readyAtMs }),
      ...(this.deadlineAtMs === undefined ? {} : { deadlineAtMs: this.deadlineAtMs }),
      inFlight: this.inFlight,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearDeadlineTimer();
    if (this.parentAbortListener) {
      this.parentSignal?.removeEventListener("abort", this.parentAbortListener);
      this.parentAbortListener = undefined;
    }
    if (this.state === "waiting" || this.state === "ready") this.stop("disposed", true);
  }

  private async dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.assertDispatchable();
    if (this.inFlight) {
      this.stop("overlap", true);
      throw this.errorForCurrentState();
    }
    if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) {
      this.stop("cancelled", true);
      throw this.errorForCurrentState();
    }
    let endpoint: URL;
    try {
      endpoint = new URL(input instanceof Request ? input.url : String(input));
      if (!this.allowedEndpoint(endpoint)) {
        this.stop("endpoint-blocked", false);
        throw this.errorForCurrentState();
      }
    } catch (error) {
      if (error instanceof HostedDispatchGuardError) throw error;
      this.stop("endpoint-blocked", false);
      throw this.errorForCurrentState();
    }
    if (this.dispatches >= this.maxDispatches) {
      this.stop("dispatch-limit", false);
      throw this.errorForCurrentState();
    }

    const requestSignals = [this.controller.signal];
    if (this.parentSignal) requestSignals.push(this.parentSignal);
    if (input instanceof Request) requestSignals.push(input.signal);
    if (init?.signal) requestSignals.push(init.signal);
    const requestSignal = AbortSignal.any(requestSignals);
    this.inFlight = true;
    this.dispatches += 1;
    try {
      const response = await this.baseFetch(input, {
        ...init,
        // Prevent an automatic redirect from escaping the endpoint allowlist.
        redirect: "manual",
        signal: requestSignal,
      });
      if (this.state === "ready" && this.deadlineAtMs !== undefined && this.now() >= this.deadlineAtMs) {
        this.stop("deadline", true);
      }
      if (this.state !== "ready") {
        void response.body?.cancel().catch(() => undefined);
        throw this.errorForCurrentState();
      }
      if (!response.ok) this.stop("external-failure", false);
      return response;
    } catch {
      if (this.state === "ready") {
        if (this.parentSignal?.aborted || init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) {
          this.stop("cancelled", true);
        } else {
          this.stop("external-failure", false);
        }
      }
      if (this.state !== "ready") throw this.errorForCurrentState();
      throw new HostedDispatchGuardError("external-failure");
    } finally {
      this.inFlight = false;
    }
  }

  private assertDispatchable(): void {
    if (this.disposed) throw new HostedDispatchGuardError("disposed");
    if (this.parentSignal?.aborted && (this.state === "waiting" || this.state === "ready")) {
      this.stop("cancelled", true);
    }
    if (this.state === "waiting") throw new HostedDispatchGuardError("not-ready");
    if (this.state !== "ready") throw this.errorForCurrentState();
    if (this.deadlineAtMs !== undefined && this.now() >= this.deadlineAtMs) {
      this.stop("deadline", true);
      throw this.errorForCurrentState();
    }
  }

  private stop(reason: GuardStopReason, abortInFlight: boolean): void {
    if (this.state !== "waiting" && this.state !== "ready") return;
    this.state = reason;
    this.clearDeadlineTimer();
    if (abortInFlight && !this.controller.signal.aborted) {
      this.controller.abort(new HostedDispatchGuardError(reason));
    }
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer !== undefined) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }

  private errorForCurrentState(): HostedDispatchGuardError {
    return new HostedDispatchGuardError(this.state === "waiting" || this.state === "ready" ? "not-ready" : this.state);
  }
}
