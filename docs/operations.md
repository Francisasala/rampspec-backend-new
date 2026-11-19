# Operations

Liveness is exposed at `/health`; dependency readiness is exposed at `/ready`. Review trace IDs and audit events together when investigating a run. Treat evidence as immutable and use the retention planner before deleting expired artifacts.

Deploy only immutable image digests through the protected staging or production environment. Verify backup manifests before restores and stop traffic when tenant isolation, readiness, or signature checks fail.

Target probes are memory-bounded: a single retained header value is capped at 4,096 bytes, retained headers at 8,192 bytes combined, all response headers at 65,536 bytes combined, and the response body at 65,536 bytes, with at most 32 SEP identifiers retained. A probe that exceeds any budget aborts, discards all partial content, and records `budgetExceeded` with a `limitReason` on the probe plus a `target-probe-response-bounded` finding on the run report. No partial response content reaches logs or evidence manifests.

## Web session revocation

`DELETE /v1/sessions/{sessionId}` revokes one web session selected by its
identifier. The caller authenticates with their own session token and CSRF
token; only a session owned by the caller can be revoked. Malformed, missing,
and foreign session identifiers all return the same `session-not-found`
(404) response so session existence cannot be enumerated. Revocation is
idempotent: repeating it returns the original revocation time without
emitting a second audit record. Server state is invalidated before the
`session.revoked` audit record is emitted and before success is returned,
and any later use of the revoked session is rejected. An optional
`reason` (1–128 characters, default `user_revoked`) is stored on the
session row. No new migration is required: `rampspec.web_sessions` already
carries `revoked_at` and `revoke_reason` and is keyed by session id.
