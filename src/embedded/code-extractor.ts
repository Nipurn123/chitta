// Code → graph extractor (the Graphify capability, ported TS-native). Parses source
// with tree-sitter (WASM grammars) into the SAME entity/edge shape every other
// extractor produces - so code nodes get ACL, vectors, temporal edges, and graph
// algorithms for free. STRICT SUPERSET of Graphify in one embedded store.
//
// Thin facade: the implementation lives in ./extractors/code and is re-exported here
// so existing imports keep resolving unchanged. Public API is preserved exactly.

export { CodeExtractor } from "./extractors/code"
