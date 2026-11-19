# Operations

Liveness is exposed at `/health`; dependency readiness is exposed at `/ready`. Review trace IDs and audit events together when investigating a run. Treat evidence as immutable and use the retention planner before deleting expired artifacts.

Deploy only immutable image digests through the protected staging or production environment. Verify backup manifests before restores and stop traffic when tenant isolation, readiness, or signature checks fail.

Target probes are memory-bounded: a single retained header value is capped at 4,096 bytes, retained headers at 8,192 bytes combined, all response headers at 65,536 bytes combined, and the response body at 65,536 bytes, with at most 32 SEP identifiers retained. A probe that exceeds any budget aborts, discards all partial content, and records `budgetExceeded` with a `limitReason` on the probe plus a `target-probe-response-bounded` finding on the run report. No partial response content reaches logs or evidence manifests.
