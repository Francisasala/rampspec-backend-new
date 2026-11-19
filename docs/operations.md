# Operations

Liveness is exposed at `/health`; dependency readiness is exposed at `/ready`. Review trace IDs and audit events together when investigating a run. Treat evidence as immutable and use the retention planner before deleting expired artifacts.

Deploy only immutable image digests through the protected staging or production environment. Verify backup manifests before restores and stop traffic when tenant isolation, readiness, or signature checks fail.

Ownership challenges live at most 24 hours (TTL 60–86400 seconds, default 900) and expire exclusively: a proof presented at exactly `expiresAt` is expired. An expired proof is rejected and the challenge moves to the terminal `expired` state; renewal issues a fresh challenge and token and moves the previous challenge to `revoked` (or `expired` when its lifetime already lapsed), so expired proof material is never revived. A target counts as verified only through a challenge verified while current. Audit actions `target.ownership_challenge.created`, `.renewed`, `.verified`, and `.revoked` trace each transition.
