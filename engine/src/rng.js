const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function mix32(x) {
  let z = x >>> 0;
  z ^= z >>> 16;
  z = Math.imul(z, 0x7feb352d) >>> 0;
  z ^= z >>> 15;
  z = Math.imul(z, 0x846ca68b) >>> 0;
  z ^= z >>> 16;
  return z >>> 0;
}

export function makeRng(seedStr) {
  const seed = fnv1a(String(seedStr));
  let a = mix32(seed ^ 0x9e3779b9);
  let b = mix32(seed ^ 0x243f6a88);
  let c = mix32(seed ^ 0xb7e15162);
  let d = mix32(seed ^ 0xdeadbeef);

  if ((a | b | c | d) === 0) {
    d = 0x1a2b3c4d;
  }

  function next() {
    const t = (a ^ (a << 11)) >>> 0;
    a = b;
    b = c;
    c = d;
    d = (d ^ (d >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return d;
  }

  function nextInt(n) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError("nextInt(n) requires a positive integer");
    }
    const limit = Math.floor(0x100000000 / n) * n;
    let value = next();
    while (value >= limit) {
      value = next();
    }
    return value % n;
  }

  return { next, nextInt };
}
