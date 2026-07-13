import { describe, expect, it } from "vitest";
import { makeRng } from "../src/rng.js";

describe("makeRng", () => {
  it("produces a deterministic uint32 stream for a string seed", () => {
    const a = makeRng("abc123");
    const b = makeRng("abc123");
    const c = makeRng("different");

    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    const seqC = Array.from({ length: 20 }, () => c.next());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(seqA.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)).toBe(true);
  });

  it("nextInt returns values in range", () => {
    const rng = makeRng("range");
    for (let n = 1; n < 100; n += 1) {
      for (let i = 0; i < 25; i += 1) {
        const value = rng.nextInt(n);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(n);
      }
    }
  });
});
