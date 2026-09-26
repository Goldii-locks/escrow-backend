import {
  EMAIL_TEMPLATE_ERRORS,
  EmailTemplateRegistry,
  findPlaceholders,
  interpolate,
  parseTemplateConfig,
  type EmailTemplateConfig,
} from "../src/utils/email_sender_templates.js";

const MILESTONE: EmailTemplateConfig = {
  id: "milestone-released",
  subject: "Escrow milestone {{ milestone }} released",
  html: "<p>Hi {{name}},</p><p><strong>{{ amount }} {{ asset }}</strong> was released.</p>",
  text: "Hi {{name}}, {{ amount }} {{ asset }} was released.",
  variables: ["milestone", "name", "amount", "asset"],
  requiredVariables: ["name"],
  defaults: { name: "there", asset: "XLM" },
};

const REGISTRY = new EmailTemplateRegistry([MILESTONE]);

describe("email_sender_templates", () => {
  describe("findPlaceholders", () => {
    it("collects unique, sorted placeholder names across bodies", () => {
      expect(findPlaceholders("{{b}} {{a}}", "{{a}} {{ c }}")).toEqual(["a", "b", "c"]);
      expect(findPlaceholders(null, undefined, "no placeholders")).toEqual([]);
    });
  });

  describe("parseTemplateConfig", () => {
    it("normalises a valid config and records referenced placeholders", () => {
      const parsed = parseTemplateConfig(MILESTONE);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.template.id).toBe("milestone-released");
        expect(parsed.template.referencedVariables).toEqual(["amount", "asset", "milestone", "name"]);
        expect(parsed.template.requiredVariables).toEqual(["name"]);
        expect(parsed.template.defaults).toEqual({ name: "there", asset: "XLM" });
      }
    });

    it("requires an id, a subject and at least one body", () => {
      expect(parseTemplateConfig({}).ok).toBe(false);
      expect(parseTemplateConfig({ id: "x" }).ok).toBe(false);
      expect(parseTemplateConfig({ id: "x", subject: "s" }).ok).toBe(false);
      expect(parseTemplateConfig(null).ok).toBe(false);
    });

    it("rejects a placeholder that was not declared", () => {
      const parsed = parseTemplateConfig({
        id: "typo",
        subject: "Hello {{ nmae }}",
        text: "body",
        variables: ["name"],
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.code).toBe(EMAIL_TEMPLATE_ERRORS.UNKNOWN_VARIABLE);
        expect(parsed.error).toContain("nmae");
      }
    });

    it("rejects an unbalanced placeholder delimiter", () => {
      const parsed = parseTemplateConfig({ id: "broken", subject: "Hello {{name", text: "body" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe(EMAIL_TEMPLATE_ERRORS.INVALID_PLACEHOLDER);
    });

    it("rejects a required variable that is neither declared nor defaulted", () => {
      const parsed = parseTemplateConfig({
        id: "req",
        subject: "Hi {{name}}",
        text: "body",
        variables: ["name"],
        requiredVariables: ["account"],
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe(EMAIL_TEMPLATE_ERRORS.UNKNOWN_VARIABLE);
    });
  });

  describe("interpolate — values are substituted without HTML escaping", () => {
    it("inserts markup verbatim rather than entity-escaping it", () => {
      const result = interpolate("Hi {{name}}, welcome to {{brand}}", {
        name: "<b>Ana</b> & Co",
        brand: "Goldii <span>Escrow</span>",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("Hi <b>Ana</b> & Co, welcome to Goldii <span>Escrow</span>");
        expect(result.text).not.toContain("&lt;");
        expect(result.text).not.toContain("&amp;");
      }
    });

    it("preserves an HTML body block untouched around the placeholder", () => {
      const result = interpolate("<p>Hi {{name}}</p>", { name: "<em>Ana</em>" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.text).toBe("<p>Hi <em>Ana</em></p>");
    });

    it("tolerates surrounding whitespace inside the placeholder", () => {
      const result = interpolate("{{  name  }}", { name: "Ana" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.text).toBe("Ana");
    });

    it("stringifies numbers and booleans and renders null as empty", () => {
      const result = interpolate("{{a}}|{{b}}|{{c}}", { a: 1_500_000, b: true, c: null });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.text).toBe("1500000|true|");
    });

    it("reports every missing variable at once", () => {
      const result = interpolate("{{a}} and {{b}}", { a: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(EMAIL_TEMPLATE_ERRORS.MISSING_VARIABLE);
        expect(result.error).toContain("b");
      }
    });
  });

  describe("EmailTemplateRegistry", () => {
    it("indexes configs by id", () => {
      expect(REGISTRY.ids()).toEqual(["milestone-released"]);
      expect(REGISTRY.size()).toBe(1);
      expect(REGISTRY.has("milestone-released")).toBe(true);
      expect(REGISTRY.get("milestone-released")!.subject).toContain("{{ milestone }}");
    });

    it("rejects duplicate ids at construction", () => {
      expect(() => new EmailTemplateRegistry([MILESTONE, MILESTONE])).toThrow(
        EMAIL_TEMPLATE_ERRORS.DUPLICATE_TEMPLATE
      );
    });

    it("surfaces the parse error at construction", () => {
      expect(() => new EmailTemplateRegistry([{ id: "x" }])).toThrow(EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
    });

    it("renders subject, html and text, applying defaults", () => {
      const rendered = REGISTRY.render("milestone-released", { milestone: 3, amount: "1.5000000" });
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        expect(rendered.subject).toBe("Escrow milestone 3 released");
        expect(rendered.html).toBe(
          "<p>Hi there,</p><p><strong>1.5000000 XLM</strong> was released.</p>"
        );
        expect(rendered.text).toBe("Hi there, 1.5000000 XLM was released.");
      }
    });

    it("lets caller variables override defaults", () => {
      const rendered = REGISTRY.render("milestone-released", {
        milestone: 1,
        amount: "2.0000000",
        name: "<b>Ana</b>",
        asset: "USDC",
      });
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        expect(rendered.html).toContain("<p>Hi <b>Ana</b>,</p>");
        expect(rendered.html).toContain("<strong>2.0000000 USDC</strong>");
      }
    });

    it("returns UNKNOWN_TEMPLATE for an id that is not configured", () => {
      const rendered = REGISTRY.render("nope", {});
      expect(rendered.ok).toBe(false);
      if (!rendered.ok) expect(rendered.code).toBe(EMAIL_TEMPLATE_ERRORS.UNKNOWN_TEMPLATE);
    });

    it("returns MISSING_VARIABLE when a required variable is absent", () => {
      const registry = new EmailTemplateRegistry([
        { id: "strict", subject: "Hi {{name}}", text: "{{name}}", variables: ["name"], requiredVariables: ["name"] },
      ]);
      const rendered = registry.render("strict", {});
      expect(rendered.ok).toBe(false);
      if (!rendered.ok) expect(rendered.code).toBe(EMAIL_TEMPLATE_ERRORS.MISSING_VARIABLE);
    });
  });
});
