# Operations

Liveness is exposed at `/health`; dependency readiness is exposed at `/ready`. Review trace IDs and audit events together when investigating a run. Treat evidence as immutable and use the retention planner before deleting expired artifacts.

Deploy only immutable image digests through the protected staging or production environment. Verify backup manifests before restores and stop traffic when tenant isolation, readiness, or signature checks fail.

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
