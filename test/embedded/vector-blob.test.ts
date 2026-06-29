// Float32 BLOB codec + hot-loop math: roundtrip, legacy JSON-TEXT back-compat, dot/cosine
// equivalence for normalized vectors, and the bounded top-k selector.
import { test, expect, describe } from "bun:test"
import { encodeF32, decodeF32, dot, normalize, TopK } from "../../src/embedded/store/vector-blob"

describe("vector-blob codec", () => {
  test("encode → decode roundtrips Float32 values", () => {
    const v = [0.1, -0.5, 0.25, 1, 0]
    const back = decodeF32(encodeF32(v))
    expect(back.length).toBe(5)
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i], 5)
  })

  test("decode still reads legacy JSON-TEXT (backward compatible)", () => {
    const back = decodeF32(JSON.stringify([1, 2, 3]))
    expect(Array.from(back)).toEqual([1, 2, 3])
  })

  test("encoded blob is compact (4 bytes/dim)", () => {
    expect(encodeF32(new Array(256).fill(0.5)).byteLength).toBe(256 * 4)
  })

  test("dot == cosine for L2-normalized vectors", () => {
    const a = normalize([3, 4, 0]) // → (0.6, 0.8, 0)
    const b = normalize([4, 3, 0])
    // cosine of these is 0.96; dot of the normalized forms must equal that
    expect(dot(a, b)).toBeCloseTo(0.96, 5)
    expect(dot(a, a)).toBeCloseTo(1, 5)
  })

  test("TopK keeps only the k best, sorted best-first", () => {
    const t = new TopK<string>(3)
    for (const [s, v] of [[0.1, "a"], [0.9, "b"], [0.5, "c"], [0.95, "d"], [0.3, "e"]] as Array<[number, string]>) t.offer(s, v)
    expect(t.values().map((x) => x.value)).toEqual(["d", "b", "c"]) // 0.95, 0.9, 0.5
  })
})
