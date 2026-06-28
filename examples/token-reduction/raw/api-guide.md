# API Integration Guide

This guide covers how external clients authenticate and call the Acme API. It is intended for engineers integrating a service.

## Authentication

The API uses short-lived bearer tokens. A client exchanges its credentials at the token endpoint for an access token that expires in fifteen minutes, then refreshes as needed. Long-lived API keys are not supported because a leaked long-lived key is a standing breach. Every request must carry the token in the Authorization header; unauthenticated requests are rejected before any work is done.

## Scopes and permissions

Tokens carry scopes that map to the same permission model used internally. A token scoped to read a user's records can only retrieve records that user is permitted to see - the API enforces the identical access-control gate as the rest of the platform, so there is no privileged backdoor. Request the narrowest scope that does the job.

## Core endpoints

The ingest endpoint stores text and returns a record id; you pass the sharing scope so permission edges are created at write time. The retrieve endpoint takes a query and a user identity and returns ranked, cited, permission-filtered snippets. The graph endpoint returns the knowledge graph of concepts and relationships the identity may access.

## Rate limits

Limits are per-token and returned in response headers so you can back off gracefully. A burst allowance absorbs short spikes; sustained traffic above the limit is throttled rather than dropped. If you need a higher limit for a legitimate batch job, request it rather than retrying aggressively, which only makes congestion worse.

## Errors and retries

The API uses standard status codes. Retry only idempotent calls, and only on 429 and 5xx responses, with exponential backoff and jitter. Never retry a 4xx other than 429 - the request is malformed or unauthorized and will fail again. Every error response includes a request id; include it when you contact support.

## Versioning

Breaking changes ship behind a new version prefix; the previous version is supported for at least six months after a successor is announced. Additive, backward-compatible changes can land in place. Pin the version you integrate against and read the changelog before upgrading.
