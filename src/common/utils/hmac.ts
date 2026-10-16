// src/common/utils/hmac.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * HMAC-SHA256 over the UTF-8 bytes of `message`, lowercase hex.
 *
 * Shared by both directions of the WebSaco3 integration (outbound invoice
 * publication signs a body, inbound holders pull verifies a request) so the
 * primitive lives in exactly one place. What gets signed — and therefore the
 * purpose of the signature — stays with each caller.
 */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two lowercase-hex SHA-256 digests. Returns
 * `false` — never throws — for anything that is not exactly 64 lowercase hex
 * characters on either side, so a malformed input cannot be told apart from a
 * wrong signature by a thrown-vs-compared distinction.
 *
 * Decoding to 32-byte buffers first guarantees `timingSafeEqual` always sees
 * equal lengths.
 */
export function hmacHexEquals(
  expectedHex: string,
  receivedHex: string,
): boolean {
  if (
    typeof expectedHex !== 'string' ||
    typeof receivedHex !== 'string' ||
    !HEX_SHA256.test(expectedHex) ||
    !HEX_SHA256.test(receivedHex)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expectedHex, 'hex'),
    Buffer.from(receivedHex, 'hex'),
  );
}
