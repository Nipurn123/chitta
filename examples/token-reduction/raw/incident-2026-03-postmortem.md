# Postmortem: March 2026 Retrieval Latency Incident

This is a blameless postmortem for the SEV2 that degraded retrieval latency for roughly ninety minutes in March 2026. It focuses on the conditions that allowed the failure, not on any individual.

## Summary

For about ninety minutes, retrieval p99 latency rose from under two hundred milliseconds to over four seconds for a subset of large tenants. No data was lost or exposed, and no permission boundary was crossed. The cause was an unindexed query path that became hot after a tenant's corpus crossed a size threshold.

## Timeline

The first alert fired when p99 latency crossed the warning threshold. The on-call engineer acknowledged within three minutes and opened an incident. Initial investigation suspected the vector store, which was a dead end and cost about twenty minutes. The real cause - a permission traversal falling back to a full scan for very large accessible sets - was found by profiling a slow request end to end. Adding the missing index restored normal latency immediately.

## Root cause

The access-control traversal had an index that covered typical accessible-set sizes but degraded to a linear scan once a tenant's permitted record set grew past tens of thousands. Under normal load this path was fast, so the gap went unnoticed until a large customer grew into it. The system behaved exactly as written; the writing simply did not anticipate that scale.

## What went well

Detection was fast and the on-call followed the runbook: acknowledge, communicate, mitigate. Communication cadence held at fifteen-minute updates, so no parallel investigations spun up. The fix, once the cause was clear, was low risk and reversible.

## What went wrong

We had no load test that exercised very large accessible sets, so the cliff was invisible until production found it. The twenty minutes lost to the vector-store hypothesis came from guessing instead of profiling first.

## Action items

Add a load test that grows accessible-set size until latency degrades, and alert before the cliff. Add an index-coverage check to CI for the permission traversal. Update the runbook to profile a single slow request before forming a hypothesis. Each item has an owner and a due date and is tracked to completion.
