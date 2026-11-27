# Operations

Liveness is exposed at `/health`; dependency readiness is exposed at `/ready`. Review trace IDs and audit events together when investigating a run. Treat evidence as immutable and use the retention planner before deleting expired artifacts.

### Database Migrations
Inspect pending migrations before execution:
```shell
pnpm db:migrate:dry-run
# or machine-readable JSON:
node scripts/migrate.mjs --dry-run --json
```
Apply migrations:
```shell
pnpm db:migrate
```

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

## OIDC login callbacks

`OidcAuthorizationFlow` generates, persists, and single-use consumes bounded `state` and `nonce` values for each login. Only SHA-256 digests are persisted (table `rampspec.oidc_authorization_requests`, migration 0010); raw values exist only in the initiating request and the provider redirect.

- Requests expire after 600 seconds by default (configurable 60–3600 seconds) and pending requests are capped at 1000; a new request is refused rather than evicting an in-flight one.
- A callback succeeds only for the initiating authentication request: missing, malformed, unknown, expired, or already-consumed `state` is rejected, and the identity token nonce must match the request. Consuming a `state` is atomic, so a failed token check still burns the `state` and it can never be replayed.
- Callback failures create no session and the audit event (`login.failed`, reason `callback_rejected`) and the returned error contain no state, nonce, or provider token data.
- Expired pending requests are pruned when a new request begins; the `oidc_authorization_requests_expiry_idx` index supports that cleanup in the database.

## Incoming webhook signatures

The webhook service accepts `POST /v1/webhooks/incoming` only from senders
that sign the raw request body. Configure the signing secret as a secret
reference; raw secrets must never appear in configuration or logs:

```
WEBHOOK_SIGNING_SECRET_REF=vault://webhooks/signing-secret
```

Senders must include both headers:

```
X-RampSpec-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
X-RampSpec-Delivery-Id: <opaque delivery identifier>
```

The signature is HMAC-SHA256 over `<timestamp>.<delivery-id>.<raw body>`.
Verification rejects, with `401` and a reason code, any request that is
missing or malformed, has a timestamp more than 300 seconds from the server
clock in either direction, fails the constant-time signature comparison, or
reuses a delivery ID seen inside the tolerance window. Only requests that
pass every check reach event processing; failed attempts never poison the
replay store. Rotate the signing secret by updating the secret reference and
restarting the webhook service. Rejection responses contain only the reason
code (`missing-signature`, `malformed-signature`, `missing-delivery-id`,
`malformed-delivery-id`, `stale-timestamp`, `invalid-signature`,
`replayed-delivery`); never log request bodies or secrets when investigating
a rejection.

## Scheduled-run misfire policy

When the scheduler is down, runs whose scheduled time passes are missed. On
recovery, `ScheduleService.recover` applies the schedule's misfire policy
deterministically for the recovery instant:

- `skip` (default): missed runs are dropped; the next run is the first
  occurrence after recovery. No replayed execution is ever created.
- `run-once`: exactly one execution is due, however many occurrences were
  missed; the next run is the first occurrence after recovery.
- `catch-up`: each missed occurrence is due, bounded by the schedule's
  `maxCatchUp` (1–10, default 10). When more occurrences were missed than
  the limit, the recovery is flagged `capped: true` and the excess is
  dropped, never queued. Catch-up therefore cannot create an unreviewed
  burst of executions after a long outage.

Recovery is idempotent: repeating it at the same instant reports zero
missed occurrences because the next run already lies in the future.
Disabled schedules refuse recovery. Every recovery records
`lastMisfire` on the schedule and returns audit metadata
(`misfire_policy`, `missed_occurrences`, `executions_due`,
`misfire_capped`, `schedule_id`) for the audit trail; the durable record
lives in `rampspec.schedule_misfires` (migration 0010). Changing a
schedule's misfire policy requires the `schedule.write` action
(maintainer and above); reading schedule state requires `schedule.read`.

## Scheduled executions

Each schedule occurrence runs at most once. The scheduler derives a stable
occurrence key, `schedule:<schedule-id>:<occurrence-timestamp>` in UTC, and
uses it as the run idempotency key. The run store claims that key atomically:
the first claim creates the run and every duplicate claim — a retry, a
second sweep, or a failover replica — returns the original run reference
instead of creating another run. The schedule advances past an occurrence
only after the run claim succeeds, so a scheduler crash before the claim
leaves the occurrence due and the next sweep retries it idempotently.

In PostgreSQL the cross-process guarantee is `UNIQUE (organization_id,
idempotency_key)` on `rampspec.runs` (migration 0005); a Postgres run
repository must map a unique violation back to the existing row. The JSON
file store used by the reference API serializes claims inside one process
only — do not run two reference-API processes against the same file and
expect cross-process deduplication.

When investigating a scheduled run, check the run's idempotency key: two
runs for one occurrence mean the key was not derived from the occurrence
(check for clock skew between scheduler replicas or a caller passing a
fresh key per attempt). A past occurrence with no run means the claim never
succeeded; re-triggering the same occurrence is safe because the claim
returns the original run once it exists.
Ownership challenges live at most 24 hours (TTL 60–86400 seconds, default 900) and expire exclusively: a proof presented at exactly `expiresAt` is expired. An expired proof is rejected and the challenge moves to the terminal `expired` state; renewal issues a fresh challenge and token and moves the previous challenge to `revoked` (or `expired` when its lifetime already lapsed), so expired proof material is never revived. A target counts as verified only through a challenge verified while current. Audit actions `target.ownership_challenge.created`, `.renewed`, `.verified`, and `.revoked` trace each transition.

## Target probe outbound network policy

A reference run probes an approved target origin over HTTPS. HTTPS alone
does not stop an approved hostname from resolving to an internal address,
so the probe defends against DNS rebinding before it connects:

- The target hostname is resolved and **every** returned address is
  validated. Loopback, private (RFC 1918 and IPv6 unique-local), link-local,
  shared (CGNAT), documentation, benchmarking, multicast, reserved, and
  unspecified addresses are rejected, as are IPv6 forms that embed such an
  IPv4 address. The cloud metadata addresses `169.254.169.254` (link-local)
  and `fd00:ec2::254` (unique-local) are therefore rejected. A single
  non-public answer rejects the whole probe; there is no fallback to a
  public answer from the same hostname.
- The probe connects to the single validated (pinned) address, never to a
  fresh DNS lookup, and re-resolves immediately before connecting: if the
  answers changed, or any fresh answer is non-public, the probe fails
  closed without opening a socket.
- TLS hostname verification is preserved: SNI and the certificate check
  use the original hostname, not the pinned IP.
- Redirects are never followed. A redirect response is returned as-is and
  the probe reports the target unreachable.
- Resolution is bounded (at most 16 addresses, 5 second resolution
  timeout) and the probe itself times out after 5 seconds by default.
- A probe rejected by this policy surfaces as an unreachable probe
  (`reachable: false`, `status: null`) and the run records a failed
  `target-reachable` finding. The probe response shape is unchanged, so no
  OpenAPI or migration change is required for this policy.

## Webhook delivery circuit breakers

Repeated failures to one webhook endpoint open a delivery circuit for that
tenant and endpoint, so a failing receiver cannot consume workers or amplify
an incident. Circuit state is persisted in
`rampspec.webhook_circuit_breakers`, keyed by organization and integration.

- **Closed (default):** delivery proceeds. Failures are counted inside a
  60-second window; 5 failures in that window open the circuit. A success
  clears the window.
- **Open:** delivery attempts to the endpoint are paused. Accepted
  deliveries stay queued as pending and are never dropped; they are retried
  after the cooldown using the usual exponential retry delay.
- **Half-open:** after a 30-second cooldown, exactly one probe delivery is
  admitted. A successful probe closes the circuit and resumes delivery; a
  failed probe re-opens it for another full cooldown.

Circuits are scoped per tenant and endpoint: one tenant's open circuit never
pauses delivery for another tenant or for a different endpoint of the same
tenant.

Circuit state is exposed through metrics:

- `webhook_circuit_breaker_failures_total` — recorded endpoint failures.
- `webhook_circuit_breaker_transitions_total{state=open|half-open|closed}` —
  circuit open, probe, and close transitions.
- `webhook_circuit_breaker_probes_total` — admitted half-open probes.

Recovery is automatic and needs no manual queue surgery. If an endpoint is
decommissioned, disable its integration instead of clearing circuit rows;
rows disappear with the integration through the cascading delete.

## Scheduler leases

A scheduled job runs under an exclusive lease (`rampspec.scheduler_leases`, one row per schedule) so at most one scheduler instance owns a schedule for the duration of a job.

- **Acquisition:** a scheduler acquires a lease for an enabled schedule with a TTL between 30 and 3600 seconds and receives an opaque ownership token and version 1. A second acquisition while the lease is live fails with `already_leased`; an expired lease may be taken over.
- **Renewal:** while work is active the owner renews with compare-and-set semantics — the renewal succeeds only when the stored row still carries the same owner id, token, and version and has not expired. Each success increments the version and renewal count and extends the expiry by one TTL. Renew at an interval well under the TTL (at most half) and bound the total renewals and runtime per job; the defaults cap renewals at 100 per job.
- **Loss of ownership:** a renewal that matches no row means the lease expired, was released, or was taken over. The owner must abort the in-flight job immediately and must not emit a completion event for work that lost ownership. Completion events are emitted only after a final ownership check at job end.
- **Authorization:** lease acquisition, renewal, and release require the `schedule.lease` action in the caller's organization; cross-tenant renewal or release is denied. Treat the lease token as a credential: never log it or expose it outside the owning scheduler.
- **Observability:** the scheduler emits `lease.acquired`, `lease.renewed`, `lease.renewal_failed`, `lease.expired`, `lease.released`, `job.completed`, and `job.aborted` events. A `job.aborted` event with reason `lease_lost` means a job was fenced off; investigate duplicate scheduler instances or a TTL shorter than the job's renewal cadence.
- **Expiry reaping:** expired rows are inert and are replaced on the next acquisition for the same schedule; `scheduler_leases_expires_at_idx` supports reaping them in bulk.
