import { createHmac } from "crypto";
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  SIGNATURE_ERROR_CODES,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookSignatureError,
  assertValidSigningSecret,
  computeSignature,
  signPayload,
  verifySignature,
  verifySignedRequest,
} from "../src/utils/webhook_signature_verifier.js";

const SECRET = "verifier_test_secret_0123456789abcdef0123";
const NOW = 1_767_225_600;
const BODY = JSON.stringify({ event_type: "funded", data: { amount: "100" } });

function signedHeaders(body = BODY, timestamp = NOW): Record<string, string> {
  return signPayload(body, SECRET, timestamp).headers;
}

describe("webhook_signature_verifier secret signature creator (#204)", () => {
  describe("secret validation", () => {
    it.each([
      ["missing", undefined, SIGNATURE_ERROR_CODES.MISSING_SECRET],
      ["empty", "", SIGNATURE_ERROR_CODES.MISSING_SECRET],
      ["non-string", 12345, SIGNATURE_ERROR_CODES.MISSING_SECRET],
      ["too short", "x".repeat(31), SIGNATURE_ERROR_CODES.WEAK_SECRET],
    ])("rejects a %s secret", (_label, secret, code) => {
      expect(() => assertValidSigningSecret(secret)).toThrow(WebhookSignatureError);
      try {
        signPayload(BODY, secret, NOW);
        throw new Error("expected signPayload to throw");
      } catch (err) {
        expect((err as WebhookSignatureError).code).toBe(code);
      }
    });

    it("rejects an invalid signing timestamp", () => {
      expect(() => signPayload(BODY, SECRET, -1)).toThrow(
        expect.objectContaining({ code: SIGNATURE_ERROR_CODES.INVALID_TIMESTAMP })
      );
    });
  });

  describe("signature creation", () => {
    it("matches an independent client-side HMAC-SHA256 implementation", () => {
      const signed = signPayload(BODY, SECRET, NOW);
      const expected = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");
      expect(signed.signature).toBe(expected);
      expect(signed.headers).toEqual({
        [WEBHOOK_TIMESTAMP_HEADER]: String(NOW),
        [WEBHOOK_SIGNATURE_HEADER]: `sha256=${expected}`,
      });
      expect(computeSignature(BODY, SECRET, NOW)).toBe(expected);
    });

    it("verifySignature accepts prefixed and bare hex and rejects malformed input", () => {
      const { signature } = signPayload(BODY, SECRET, NOW);
      expect(verifySignature(BODY, SECRET, NOW, signature)).toBe(true);
      expect(verifySignature(BODY, SECRET, NOW, `sha256=${signature}`)).toBe(true);
      expect(verifySignature(BODY, SECRET, NOW + 1, signature)).toBe(false);
      expect(verifySignature(BODY, SECRET, NOW, "sha256=zz")).toBe(false);
      expect(verifySignature(BODY, SECRET, NOW, signature.slice(0, 62))).toBe(false);
    });
  });

  describe("verifySignedRequest", () => {
    it("accepts a freshly signed request, with case-insensitive headers", () => {
      const lowered = Object.fromEntries(
        Object.entries(signedHeaders()).map(([k, v]) => [k.toLowerCase(), v])
      );
      expect(verifySignedRequest(BODY, lowered, SECRET, { now: NOW + 10 })).toEqual({
        ok: true,
        timestamp: NOW,
      });
    });

    it("rejects a tampered body", () => {
      const result = verifySignedRequest(BODY + " ", signedHeaders(), SECRET, { now: NOW });
      expect(result).toMatchObject({ ok: false, code: SIGNATURE_ERROR_CODES.SIGNATURE_MISMATCH });
    });

    it("rejects a signature made with a different secret", () => {
      const result = verifySignedRequest(BODY, signedHeaders(), `${SECRET}-other`, { now: NOW });
      expect(result).toMatchObject({ ok: false, code: SIGNATURE_ERROR_CODES.SIGNATURE_MISMATCH });
    });

    it("rejects replays outside the tolerance window", () => {
      const result = verifySignedRequest(BODY, signedHeaders(), SECRET, {
        now: NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1,
      });
      expect(result).toMatchObject({
        ok: false,
        code: SIGNATURE_ERROR_CODES.TIMESTAMP_OUT_OF_TOLERANCE,
      });
    });

    it("rejects missing or malformed headers", () => {
      expect(verifySignedRequest(BODY, {}, SECRET, { now: NOW })).toMatchObject({
        ok: false,
        code: SIGNATURE_ERROR_CODES.MISSING_HEADER,
      });
      const headers = { ...signedHeaders(), [WEBHOOK_TIMESTAMP_HEADER]: "not-a-number" };
      expect(verifySignedRequest(BODY, headers, SECRET, { now: NOW })).toMatchObject({
        ok: false,
        code: SIGNATURE_ERROR_CODES.INVALID_TIMESTAMP,
      });
    });

    it("rejects verification with a weak secret", () => {
      expect(verifySignedRequest(BODY, signedHeaders(), "short", { now: NOW })).toMatchObject({
        ok: false,
        code: SIGNATURE_ERROR_CODES.WEAK_SECRET,
      });
    });
  });
});
