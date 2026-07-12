# Platform Architecture Overview

This document is the high-level map of how the Acme platform fits together. Read it before your first change to any backend service.

## Shape of the system

The platform is a permission-aware retrieval layer over a knowledge graph and a vector store. Every piece of content becomes a record node with permission edges describing who may see it. Retrieval always resolves permissions first, producing the set of records a user may access, and only then runs vector search constrained to that set. The permission check is the gate that produces the candidate set, never a filter applied after the fact.

## Core components

The graph provider stores nodes and edges and answers access-control traversals. The vector service stores chunk embeddings and runs approximate nearest-neighbor search. The embedding provider turns text into dense vectors. These three sit behind interfaces so the same logic runs locally over a single file or centrally over shared infrastructure.

## Local versus central

In local mode everything lives in one embedded database: graph, vectors, and chunks in a single file with no servers. In central mode the same interfaces are backed by a shared graph database, a shared vector database, and a hosted embedding service, so a whole organization queries one graph while each user sees only what their permissions allow.

## Data flow on write

Ingestion creates a record node, attaches permission edges from the document's sharing scope, chunks the text, embeds each chunk, and extracts entities and relationships into the graph. Re-ingesting a record replaces its prior contributions so the graph stays accurate and weights do not inflate.

## Data flow on read

A query resolves the asking user's accessible record set by traversing permission and membership edges. Vector search runs only within that set. Results pass a cross-connector leak guard that prevents content from one source bleeding into another, and come back cited with their source record.

## Extending it

New backends implement the provider interfaces; the access-control and retrieval logic is untouched because backends only move bytes. Adding a capability means adding a module behind an existing seam, not threading state through the whole system.
