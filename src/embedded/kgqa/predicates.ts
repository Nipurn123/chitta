// Predicate stem-matching: loosely match an edge type against a stemmed predicate
// from the parsed intent ("partnered_with" vs "partner").

import { stem } from "./text"

export function predMatch(edgeType: string, predStem: string): boolean {
  const e = stem(edgeType)
  return e === predStem || e.includes(predStem) || predStem.includes(e)
}
