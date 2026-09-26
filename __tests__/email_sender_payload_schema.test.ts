import {
  EMAIL_SENDER_ERRORS,
  PAYLOAD_SHAPES,
  matchesShape,
  normaliseEmailPayload,
  resolveShape,
  serializeEmailPayload,
  toShape,
  type EmailPayload,
} from "../src/utils/email_sender_service.js";

const BASE: EmailPayload = {
  to: "Ops@Goldii.example",
  from: "no-reply@goldii.example",
  subject: "  Escrow milestone 3 released  ",
  template: "milestone-released",
  variables: { milestone: 3, amount: "1.5000000", asset: "XLM" },
};

describe("email_sender_service payload schema", () => {
  describe("normaliseEmailPayload", () => {
    it("lowercases addresses, trims the subject and sorts variables", () => {
      const result = normaliseEmailPayload({
        ...BASE,
        variables: { zeta: 1, alpha: "a", milestone: 3 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.to).toEqual(["ops@goldii.example"]);
        expect(result.payload.from).toBe("no-reply@goldii.example");
        expect(result.payload.subject).toBe("Escrow milestone 3 released");
        expect(result.payload.template).toBe("milestone-released");
        expect(Object.keys(result.payload.variables)).toEqual(["alpha", "milestone", "zeta"]);
      }
    });

    it("accepts the `Name <addr>` form and de-duplicates recipients", () => {
      const result = normaliseEmailPayload({
        ...BASE,
        to: ["Ops <ops@goldii.example>", "ops@goldii.example", "dev@goldii.example"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.to).toEqual(["dev@goldii.example", "ops@goldii.example"]);
      }
    });

    it("defaults optional address lists to empty arrays", () => {
      const result = normaliseEmailPayload(BASE);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.cc).toEqual([]);
        expect(result.payload.bcc).toEqual([]);
        expect(result.payload.replyTo).toBeNull();
      }
    });

    it("rejects an invalid or empty recipient list", () => {
      const invalid = normaliseEmailPayload({ ...BASE, to: "not-an-email" });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.code).toBe(EMAIL_SENDER_ERRORS.INVALID_RECIPIENT);

      const empty = normaliseEmailPayload({ ...BASE, to: [] });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.code).toBe(EMAIL_SENDER_ERRORS.INVALID_RECIPIENT);
    });

    it("rejects a missing subject or template", () => {
      expect(normaliseEmailPayload({ ...BASE, subject: "   " }).ok).toBe(false);
      expect(normaliseEmailPayload({ ...BASE, template: "" }).ok).toBe(false);
    });
  });

  describe("payload shapes", () => {
    it("declares a template per consumer", () => {
      expect(PAYLOAD_SHAPES.canonical.fields).toContain("bcc");
      expect(PAYLOAD_SHAPES.transport.fields).not.toContain("template");
      expect(PAYLOAD_SHAPES.audit.fields).toEqual(["to", "subject", "template"]);
    });

    it("throws for an unknown shape name", () => {
      expect(() => resolveShape("nope")).toThrow(EMAIL_SENDER_ERRORS.UNKNOWN_SHAPE);
    });

    it("projects a payload onto a template, dropping undeclared fields", () => {
      const normalised = normaliseEmailPayload(BASE);
      expect(normalised.ok).toBe(true);
      if (!normalised.ok) return;

      const projected = toShape(normalised.payload, "audit");
      expect(Object.keys(projected)).toEqual(["to", "subject", "template"]);
      expect(projected.from).toBeUndefined();
    });
  });

  describe("serializeEmailPayload", () => {
    it("emits exactly the canonical template fields, in template order", () => {
      const result = serializeEmailPayload(BASE, "canonical");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.shape).toBe("canonical");
      expect(result.fields).toEqual(PAYLOAD_SHAPES.canonical.fields);
      expect(Object.keys(JSON.parse(result.json))).toEqual([...PAYLOAD_SHAPES.canonical.fields]);
      expect(matchesShape(result.json, "canonical")).toBe(true);
    });

    it("matches the transport template", () => {
      const result = serializeEmailPayload(BASE, "transport");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(matchesShape(result.json, "transport")).toBe(true);
      const parsed = JSON.parse(result.json);
      expect(parsed.template).toBeUndefined();
      expect(parsed.to).toEqual(["ops@goldii.example"]);
      expect(parsed.subject).toBe("Escrow milestone 3 released");
    });

    it("matches a custom template supplied inline", () => {
      const result = serializeEmailPayload(BASE, {
        name: "webhook",
        fields: ["subject", "variables", "to"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(matchesShape(result.json, {
        name: "webhook",
        fields: ["subject", "variables", "to"],
      })).toBe(true);
      expect(Object.keys(JSON.parse(result.json))).toEqual(["subject", "variables", "to"]);
    });

    it("serialises equivalently-shaped payloads identically", () => {
      const a = serializeEmailPayload({ ...BASE, variables: { zeta: 1, alpha: "a" } }, "canonical");
      const b = serializeEmailPayload({ ...BASE, variables: { alpha: "a", zeta: 1 } }, "canonical");
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.json).toBe(b.json);
    });

    it("returns the validation error instead of a payload", () => {
      const result = serializeEmailPayload({ ...BASE, to: "bad" }, "canonical");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(EMAIL_SENDER_ERRORS.INVALID_RECIPIENT);
    });

    it("returns UNKNOWN_SHAPE for an unknown shape name", () => {
      const result = serializeEmailPayload(BASE, "does-not-exist");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(EMAIL_SENDER_ERRORS.UNKNOWN_SHAPE);
    });
  });

  describe("matchesShape", () => {
    it("rejects extra keys, missing keys, non-objects and malformed JSON", () => {
      expect(matchesShape(JSON.stringify({ to: [], subject: "s", template: "t" }), "audit")).toBe(true);
      expect(matchesShape(JSON.stringify({ to: [], subject: "s", template: "t", extra: 1 }), "audit")).toBe(false);
      expect(matchesShape(JSON.stringify({ to: [], subject: "s" }), "audit")).toBe(false);
      expect(matchesShape(JSON.stringify([1, 2, 3]), "audit")).toBe(false);
      expect(matchesShape("not json", "audit")).toBe(false);
    });

    it("is order-sensitive so a template cannot be reshaped silently", () => {
      expect(matchesShape(JSON.stringify({ subject: "s", to: [], template: "t" }), "audit")).toBe(false);
    });
  });
});
