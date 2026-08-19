/**
 * portable-hash.ts — canonical SHA-256 with ZERO imports, so it runs in the browser.
 *
 * WHY THIS FILE EXISTS AT ALL. `lib/sync/fingerprint.ts` already owns the project's
 * canonical hash (`canonicalHash` = sha256 of a key-sorted JSON), and every durable
 * `sync_held_cases.fingerprint` is built with it — but it reaches sha256 through
 * `node:crypto`, which cannot ship in a client bundle. `lib/sync/findings.ts` is
 * imported by five client components AND by the worker's Excel bridge, so it is
 * deliberately import-free of anything server-only.
 *
 * The ack ledger (`sync_finding_acks`) needs a fingerprint for findings that have NO
 * durable case, and for the ones that DO it must produce the SAME STRING the case
 * already uses — two identities for one discrepancy is exactly the drift this codebase
 * spends its comments refusing. So the choice was: invent a second, cheaper hash and
 * accept two namespaces, or make the existing one reachable from the browser.
 *
 * This is the second option. `canonicalHashPortable(x)` is byte-for-byte
 * `fingerprint.ts::canonicalHash(x)` for every input — same canonicalization, same
 * JSON, same SHA-256 — and `scripts/verify-findings.ts` PROVES it by differential test
 * against `node:crypto` (including multi-byte UTF-8, block-boundary lengths and the
 * real canonical objects `caseFingerprint` builds). That assertion is the whole safety
 * argument for hand-rolling a hash, and it is the same discipline CLAUDE.md prescribes
 * for the client/server module boundary: duplicate deliberately, then assert the copies
 * agree.
 *
 * `fingerprint.ts` is NOT changed. The durable case path keeps using `node:crypto`
 * exactly as it has, so a bug here could never corrupt a case fingerprint — it could
 * only make an ack fail to match one, which the differential test catches first.
 *
 * PURE: no imports, no I/O, no globals beyond `TextEncoder` (standard in browsers and
 * Node ≥ 18). Deterministic; never throws.
 */

// ============================================================================
// SHA-256 (FIPS 180-4). Standard implementation, 32-bit word arithmetic.
// ============================================================================

/** The 64 round constants: cube roots of the first 64 primes, fractional part. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Rotate a 32-bit word right by `n` bits. */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

const HEX = '0123456789abcdef'

function toHex(words: Uint32Array): string {
  let out = ''
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    for (let shift = 28; shift >= 0; shift -= 4) {
      out += HEX[(w >>> shift) & 0xf]
    }
  }
  return out
}

/**
 * SHA-256 of a UTF-8 string, lower-case hex. Identical output to
 * `createHash('sha256').update(s).digest('hex')` — asserted, not assumed.
 */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const len = bytes.length

  // Pad: 0x80, then zeroes, then the 64-bit big-endian BIT length.
  const paddedLen = (((len + 8) >> 6) + 1) << 6 // = ceil((len + 1 + 8) / 64) * 64
  const msg = new Uint8Array(paddedLen)
  msg.set(bytes)
  msg[len] = 0x80

  const view = new DataView(msg.buffer)
  const bitLen = len * 8
  // Split the bit length across two 32-bit halves — a >4 GB input would overflow a
  // single word, and `>>>` on a number above 2^32 silently truncates.
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(paddedLen - 4, bitLen >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let off = 0; off < paddedLen; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4)
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]
      const y = w[t - 2]
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }

    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  return toHex(h)
}

// ============================================================================
// Canonicalization — a VERBATIM copy of fingerprint.ts's, deliberately duplicated
// because that file is server-only. verify-findings.ts asserts the two agree.
// ============================================================================

/**
 * Recursively sort object keys so serialization is deterministic regardless of the
 * order keys were inserted. Arrays keep their order (the caller sorts where order is
 * not semantic). Primitives pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Stable JSON: canonicalized (keys sorted recursively) then serialized. */
export function stableStringifyPortable(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * The canonical content hash, browser-safe. Byte-identical to
 * `lib/sync/fingerprint.ts::canonicalHash` for every input.
 */
export function canonicalHashPortable(value: unknown): string {
  return sha256Hex(stableStringifyPortable(value))
}
