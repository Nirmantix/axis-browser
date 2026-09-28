# Backlog

Deferred work items. Each entry states the trigger that would make it worth
doing — do not implement speculatively.

## Delta observations (measure first)

**Status:** deferred on a *measured-baseline* basis, not feasibility.

**What:** a delta/VOM-style observation layer for `snapshot` — return only what
changed since the previous snapshot for the same page.

**Why it is safe to build later:** a delta keyed on
`(session, page identity, generation)` inside the already token-gated bridge
does not touch action-ref freshness — that stays with `parseUidFresh` and
`STALE_REF` (per-page `__chromeDevtoolsAxiSnapshotGeneration`,
`src/generation.ts`, `src/snapshot.ts`, `src/uid-freshness.ts`). The delta is
orthogonal to `STALE_REF`, which is why feasibility is not the blocker.

**What is missing — evidence it pays.** Axis already truncates snapshots at
~16k chars and `eval` display at ~8k, and paginates console/network output
(`src/snapshot.ts`, `src/cli.ts`), so the theoretical win is unquantified.

**Gate to implement:**
1. First record per-`/call` request/response byte counts into the verified-run
   `action-log.md` — the `httpPost` chokepoint in `src/client.ts` already
   centralizes every call.
2. Run representative Harness-replay and Obscura fixtures with that logging on.
3. Implement delta observations only if repeated same-generation snapshots
   dominate measured request/response bytes on those runs.
