# On-Call Runbook

This runbook is for the engineer holding the pager. Keep it open during your shift.

## When a page fires

Acknowledge within five minutes so the escalation chain does not wake the next person. Open the incident channel for the alert and post that you are looking. Your first job is not to find the root cause - it is to stop the bleeding for customers. Mitigate first, diagnose second.

## Severity levels

A SEV1 is a full outage or a data-integrity or security issue: customers cannot use the product, or data may be exposed. Declare it loudly, page the incident commander, and start a timeline. A SEV2 is degraded service - slow, partial, or affecting a subset of customers. A SEV3 is a minor or internal issue that can wait for business hours. When unsure, round up; it is cheaper to downgrade later.

## Common mitigations

If a recent deploy correlates with the alert, roll it back first and ask questions afterward - rollback is almost always safe and fast. If a single tenant is causing load, rate-limit or isolate them. If a dependency is down, fail over to the secondary region. If the database is saturated, shed non-critical write traffic before reads degrade for everyone.

## Communication during an incident

Post updates every fifteen minutes even if the update is "still investigating, no new information." Silence makes people assume the worst and start their own parallel investigations. The incident commander owns external communication; engineers stay focused on the fix and feed facts to the commander.

## After it is resolved

Write a blameless postmortem within two business days while memory is fresh. Focus on the systems and conditions that let the failure happen, never on the individual who pushed the button. Every postmortem produces concrete action items with owners and due dates, tracked to completion. A postmortem with no follow-through is theater.

## Escalation

If you are stuck for thirty minutes on a SEV1, escalate - pull in the subject-matter expert or a second engineer. Asking for help quickly is a sign of good judgment, not weakness. The goal is the shortest customer impact, not personal heroics.
