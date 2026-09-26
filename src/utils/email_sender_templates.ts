/**
 * Email Sender Service — template configuration handlers
 *
 * Parses the template configs the service is started with, resolves them into a
 * registry, and interpolates alert variables into the subject/HTML/text bodies.
 *
 * Interpolation is deliberately **plain textual substitution**: escaped input is
 * never produced here. Values are inserted exactly as supplied (including
 * markup), which is what the templates expect — a caller that needs to render
 * untrusted user data must escape it before handing it over. The function's
 * return value is therefore treated as trusted template output.
 */

export const EMAIL_TEMPLATE_ERRORS = {
  INVALID_CONFIG: "EST_INVALID_CONFIG",
  DUPLICATE_TEMPLATE: "EST_DUPLICATE_TEMPLATE",
  UNKNOWN_TEMPLATE: "EST_UNKNOWN_TEMPLATE",
  UNKNOWN_VARIABLE: "EST_UNKNOWN_VARIABLE",
  MISSING_VARIABLE: "EST_MISSING_VARIABLE",
  INVALID_PLACEHOLDER: "EST_INVALID_PLACEHOLDER",
} as const;

export type EmailTemplateErrorCode =
  (typeof EMAIL_TEMPLATE_ERRORS)[keyof typeof EMAIL_TEMPLATE_ERRORS];

export type TemplateVariableValue = string | number | boolean | null;

/** A template configuration as supplied by the deployment. */
export type EmailTemplateConfig = {
  id: string;
  subject: string;
  html?: string;
  text?: string;
  /** Variables the template declares. Any placeholder outside this set is an error. */
  variables?: string[];
  /** Variables a caller must supply (unless a default exists). */
  requiredVariables?: string[];
  defaults?: Record<string, TemplateVariableValue>;
};

export type ParsedEmailTemplate = {
  id: string;
  subject: string;
  html: string | null;
  text: string | null;
  variables: readonly string[];
  requiredVariables: readonly string[];
  defaults: Readonly<Record<string, TemplateVariableValue>>;
  /** Placeholders actually referenced by the subject/html/text bodies. */
  referencedVariables: readonly string[];
};

export type TemplateParseResult =
  | { ok: true; template: ParsedEmailTemplate }
  | { ok: false; error: string; code: EmailTemplateErrorCode };

export type RenderResult =
  | { ok: true; subject: string; html: string | null; text: string | null }
  | { ok: false; error: string; code: EmailTemplateErrorCode };

/** `{{ name }}` — whitespace tolerant, dotted/hyphenated names allowed. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/** Any leftover `{{` or `}}` after replacing the well-formed placeholders. */
const MALFORMED_RE = /\{\{|\}\}/;

function fail(error: string, code: EmailTemplateErrorCode): { ok: false; error: string; code: EmailTemplateErrorCode } {
  return { ok: false, error, code };
}

/** Every placeholder name referenced anywhere in a set of bodies. */
export function findPlaceholders(...bodies: Array<string | null | undefined>): string[] {
  const found = new Set<string>();

  for (const body of bodies) {
    if (typeof body !== "string") continue;
    PLACEHOLDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_RE.exec(body)) !== null) {
      found.add(match[1]);
    }
  }

  return [...found].sort();
}

function assertWellFormed(label: string, body: string): void {
  // Replace every well-formed placeholder, then look for leftover braces.
  const leftover = body.replace(PLACEHOLDER_RE, "");
  if (MALFORMED_RE.test(leftover)) {
    throw new Error(`${EMAIL_TEMPLATE_ERRORS.INVALID_PLACEHOLDER}: ${label} has an unbalanced "{{" or "}}"`);
  }
}

/** Validate and normalise one template config. */
export function parseTemplateConfig(input: unknown): TemplateParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("template config must be an object", EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }

  const config = input as Partial<EmailTemplateConfig>;

  if (typeof config.id !== "string" || config.id.trim().length === 0) {
    return fail("template id is required", EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }
  if (typeof config.subject !== "string" || config.subject.trim().length === 0) {
    return fail(`template "${config.id}": subject is required`, EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }

  const html = typeof config.html === "string" ? config.html : null;
  const text = typeof config.text === "string" ? config.text : null;

  if (html === null && text === null) {
    return fail(
      `template "${config.id}": at least one of html or text is required`,
      EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG
    );
  }

  try {
    assertWellFormed(`${config.id} subject`, config.subject);
    if (html !== null) assertWellFormed(`${config.id} html`, html);
    if (text !== null) assertWellFormed(`${config.id} text`, text);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      EMAIL_TEMPLATE_ERRORS.INVALID_PLACEHOLDER
    );
  }

  const declared = config.variables ?? [];
  if (!Array.isArray(declared) || declared.some((name) => typeof name !== "string")) {
    return fail(`template "${config.id}": variables must be an array of names`, EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }

  const required = config.requiredVariables ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    return fail(`template "${config.id}": requiredVariables must be an array of names`, EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }

  const defaults = config.defaults ?? {};
  if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) {
    return fail(`template "${config.id}": defaults must be an object`, EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }

  const referenced = findPlaceholders(config.subject, html, text);

  // A placeholder must be declared, so a typo cannot silently render as blank.
  const declaredSet = new Set(declared);
  const undeclared = referenced.filter((name) => !declaredSet.has(name));
  if (declared.length > 0 && undeclared.length > 0) {
    return fail(
      `template "${config.id}": placeholders not declared in variables: ${undeclared.join(", ")}`,
      EMAIL_TEMPLATE_ERRORS.UNKNOWN_VARIABLE
    );
  }

  const declaredSet2 = new Set(declared.length > 0 ? declared : referenced);
  const missingRequired = required.filter(
    (name) => !declaredSet2.has(name) && !(name in defaults)
  );
  if (missingRequired.length > 0) {
    return fail(
      `template "${config.id}": required variables are not declared: ${missingRequired.join(", ")}`,
      EMAIL_TEMPLATE_ERRORS.UNKNOWN_VARIABLE
    );
  }

  return {
    ok: true,
    template: {
      id: config.id.trim(),
      subject: config.subject,
      html,
      text,
      variables: [...(declared.length > 0 ? declared : referenced)],
      requiredVariables: [...required],
      defaults: { ...defaults },
      referencedVariables: referenced,
    },
  };
}

/**
 * Substitute `{{name}}` placeholders. Values are inserted verbatim — HTML in a
 * value is preserved, not escaped, because the template author controls the
 * markup and the caller is responsible for escaping untrusted data.
 */
export function interpolate(
  body: string,
  variables: Record<string, TemplateVariableValue>
): { ok: true; text: string } | { ok: false; error: string; code: EmailTemplateErrorCode } {
  if (typeof body !== "string") {
    return fail("body must be a string", EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG);
  }

  const missing: string[] = [];

  const text = body.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(name in variables)) {
      missing.push(name);
      return "";
    }
    const value = variables[name];
    return value === null || value === undefined ? "" : String(value);
  });

  if (missing.length > 0) {
    return fail(
      `missing values for: ${[...new Set(missing)].join(", ")}`,
      EMAIL_TEMPLATE_ERRORS.MISSING_VARIABLE
    );
  }

  return { ok: true, text };
}

/** A parsed set of templates, addressed by id. */
export class EmailTemplateRegistry {
  private readonly templates = new Map<string, ParsedEmailTemplate>();

  constructor(configs: unknown[]) {
    if (!Array.isArray(configs)) {
      throw new Error(`${EMAIL_TEMPLATE_ERRORS.INVALID_CONFIG}: configs must be an array`);
    }

    for (const config of configs) {
      const parsed = parseTemplateConfig(config);
      if (!parsed.ok) {
        throw new Error(`${parsed.code}: ${parsed.error}`);
      }
      if (this.templates.has(parsed.template.id)) {
        throw new Error(
          `${EMAIL_TEMPLATE_ERRORS.DUPLICATE_TEMPLATE}: template "${parsed.template.id}" is configured twice`
        );
      }
      this.templates.set(parsed.template.id, parsed.template);
    }
  }

  get(id: string): ParsedEmailTemplate | undefined {
    return this.templates.get(id);
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  ids(): string[] {
    return [...this.templates.keys()].sort();
  }

  size(): number {
    return this.templates.size;
  }

  /** Interpolate an alert as `{ variables }` or `{ html: { variables } }`. */
  render(id: string, variables: Record<string, TemplateVariableValue> = {}): RenderResult {
    const template = this.templates.get(id);
    if (!template) {
      return fail(`unknown template "${id}"`, EMAIL_TEMPLATE_ERRORS.UNKNOWN_TEMPLATE);
    }

    const merged: Record<string, TemplateVariableValue> = { ...template.defaults, ...variables };

    const missingRequired = template.requiredVariables.filter(
      (name) => !(name in merged) || merged[name] === null
    );
    if (missingRequired.length > 0) {
      return fail(
        `template "${id}" is missing required variables: ${missingRequired.join(", ")}`,
        EMAIL_TEMPLATE_ERRORS.MISSING_VARIABLE
      );
    }

    const subject = interpolate(template.subject, merged);
    if (!subject.ok) return subject;

    let html: string | null = null;
    if (template.html !== null) {
      const rendered = interpolate(template.html, merged);
      if (!rendered.ok) return rendered;
      html = rendered.text;
    }

    let text: string | null = null;
    if (template.text !== null) {
      const rendered = interpolate(template.text, merged);
      if (!rendered.ok) return rendered;
      text = rendered.text;
    }

    return { ok: true, subject: subject.text, html, text };
  }
}
