import {
  ERROR_CODES,
  MAX_SAFE_DIGITS,
  PARAMETER_ERROR_BODY_KEYS,
  PARAMETER_ERROR_DEFINITIONS,
  PARAMETER_WARNING_CODES,
  collectParameterWarnings,
  describeParameterWarning,
  listUncoveredParameterCodes,
  matchesErrorDefinition,
  toErrorResponse,
  type ParameterWarning,
  type ParameterWarningCode,
} from "../src/utils/audit_ledger_sum_checker.js";

const ALL_CODES = Object.values(PARAMETER_WARNING_CODES) as ParameterWarningCode[];

describe("audit_ledger_sum_checker parameter warning codes", () => {
  describe("error definition list", () => {
    it("covers every declared warning code exactly once", () => {
      expect(listUncoveredParameterCodes()).toEqual([]);
      const defined = PARAMETER_ERROR_DEFINITIONS.map((definition) => definition.code);
      expect(new Set(defined).size).toBe(defined.length);
      expect(defined).toHaveLength(ALL_CODES.length);
    });

    it("gives every definition a summary and a 4xx status", () => {
      for (const definition of PARAMETER_ERROR_DEFINITIONS) {
        expect(definition.summary.trim().length).toBeGreaterThan(0);
        expect([400, 422]).toContain(definition.httpStatus);
        expect(definition.parameter.trim().length).toBeGreaterThan(0);
      }
    });

    it("resolves a definition by code and rejects an unknown one", () => {
      expect(describeParameterWarning(PARAMETER_WARNING_CODES.AMOUNT_MISSING)!.parameter).toBe("amount");
      expect(describeParameterWarning("NOT_A_CODE" as ParameterWarningCode)).toBeUndefined();
    });
  });

  describe("collectParameterWarnings", () => {
    it("reports a blank label", () => {
      const warnings = collectParameterWarnings({ label: "   " });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe(PARAMETER_WARNING_CODES.LABEL_MISSING);
      expect(warnings[0].parameter).toBe("label");
    });

    it("reports a non-array and an empty amounts input separately", () => {
      expect(collectParameterWarnings({ amounts: "10" })[0].code).toBe(
        PARAMETER_WARNING_CODES.AMOUNTS_NOT_ARRAY
      );
      expect(collectParameterWarnings({ amounts: [] })[0].code).toBe(
        PARAMETER_WARNING_CODES.AMOUNTS_EMPTY
      );
    });

    it("points at the offending ledger index", () => {
      const warnings = collectParameterWarnings({ amounts: [null, "abc"] });

      expect(warnings).toHaveLength(2);
      expect(warnings[0].code).toBe(PARAMETER_WARNING_CODES.AMOUNT_MISSING);
      expect(warnings[0].index).toBe(0);
      expect(warnings[0].parameter).toBe("amounts[0]");

      expect(warnings[1].code).toBe(PARAMETER_WARNING_CODES.ENTRY_INVALID);
      expect(warnings[1].index).toBe(1);
      expect(warnings[1].calculationCode).toBe(ERROR_CODES.INVALID_AMOUNT);
    });

    it("maps an over-long ledger entry back to the overflow code", () => {
      const tooBig = "1" + "0".repeat(MAX_SAFE_DIGITS);
      const warnings = collectParameterWarnings({ amounts: [tooBig] });
      expect(warnings[0].code).toBe(PARAMETER_WARNING_CODES.AMOUNT_EXCESSIVE_DIGITS);
      expect(warnings[0].calculationCode).toBe(ERROR_CODES.EXCESSIVE_DIGITS);
    });

    it("flags negative amounts in a list and on their own", () => {
      const inList = collectParameterWarnings({ amounts: [-5] });
      expect(inList[0].code).toBe(PARAMETER_WARNING_CODES.AMOUNT_NEGATIVE);
      expect(inList[0].parameter).toBe("amounts[0]");

      const single = collectParameterWarnings({ amount: -5 });
      expect(single[0].code).toBe(PARAMETER_WARNING_CODES.AMOUNT_NEGATIVE);
      expect(single[0].parameter).toBe("amount");
    });

    it("distinguishes a missing amount, a fractional amount and a valid one", () => {
      expect(collectParameterWarnings({ amount: undefined })[0].code).toBe(
        PARAMETER_WARNING_CODES.AMOUNT_MISSING
      );
      expect(collectParameterWarnings({ amount: "12.5" })[0].code).toBe(
        PARAMETER_WARNING_CODES.AMOUNT_NOT_INTEGER
      );
      expect(collectParameterWarnings({ amount: "100" })).toEqual([]);
    });

    it("validates the divisor for both type and range", () => {
      expect(collectParameterWarnings({ divisor: 2.5 })[0].code).toBe(
        PARAMETER_WARNING_CODES.DIVISOR_NOT_INTEGER
      );
      expect(collectParameterWarnings({ divisor: 0 })[0].code).toBe(
        PARAMETER_WARNING_CODES.DIVISOR_OUT_OF_RANGE
      );
      expect(collectParameterWarnings({ divisor: 4 })).toEqual([]);
    });

    it("separates a zero scale denominator from an unusable one", () => {
      expect(collectParameterWarnings({ scaleDenominator: 0 })[0].code).toBe(
        PARAMETER_WARNING_CODES.SCALE_DENOMINATOR_ZERO
      );
      expect(collectParameterWarnings({ scaleDenominator: "abc" })[0].code).toBe(
        PARAMETER_WARNING_CODES.TYPE_INVALID
      );
      expect(collectParameterWarnings({ scaleNumerator: "abc" })[0].code).toBe(
        PARAMETER_WARNING_CODES.SCALE_NUMERATOR_INVALID
      );
    });

    it("reports every problem in one pass, in a stable order", () => {
      const warnings = collectParameterWarnings({
        label: "",
        amounts: [null, "abc"],
        divisor: 0,
      });
      expect(warnings.map((warning) => warning.code)).toEqual([
        PARAMETER_WARNING_CODES.LABEL_MISSING,
        PARAMETER_WARNING_CODES.AMOUNT_MISSING,
        PARAMETER_WARNING_CODES.ENTRY_INVALID,
        PARAMETER_WARNING_CODES.DIVISOR_OUT_OF_RANGE,
      ]);
    });
  });

  describe("response body shapes", () => {
    it("builds a body that matches the definition list for every code", () => {
      for (const code of ALL_CODES) {
        const warning: ParameterWarning = {
          code,
          parameter: "amount",
          message: "detail",
          index: null,
          calculationCode: null,
        };
        const body = toErrorResponse(warning);

        expect(body.success).toBe(false);
        expect(Object.keys(body.error).sort()).toEqual([...PARAMETER_ERROR_BODY_KEYS].sort());
        expect(body.error.code).toBe(code);
        expect(body.error.httpStatus).toBe(describeParameterWarning(code)!.httpStatus);
        expect(body.error.summary).toBe(describeParameterWarning(code)!.summary);
        expect(matchesErrorDefinition(body)).toBe(true);
        expect(matchesErrorDefinition(body, code)).toBe(true);
      }
    });

    it("carries the offending parameter and the calculation detail", () => {
      const warning = collectParameterWarnings({ amount: "12.5" })[0];
      const body = toErrorResponse(warning);

      expect(body.error.code).toBe(PARAMETER_WARNING_CODES.AMOUNT_NOT_INTEGER);
      expect(body.error.parameter).toBe("amount");
      expect(body.error.httpStatus).toBe(400);
      expect(body.error.message).toContain("integer");
    });

    it("lets an explicit detail override the warning message", () => {
      const warning = collectParameterWarnings({ divisor: 0 })[0];
      expect(toErrorResponse(warning, "custom detail").error.message).toBe("custom detail");
    });

    it("rejects a body whose code is not in the definition list", () => {
      const warning = collectParameterWarnings({ amount: "12.5" })[0];
      const body = toErrorResponse(warning);
      expect(matchesErrorDefinition({ ...body, error: { ...body.error, code: "NOPE" } })).toBe(false);
    });

    it("rejects a body with a wrong status, a wrong summary, an extra key or an empty message", () => {
      const warning = collectParameterWarnings({ amount: "12.5" })[0];
      const body = toErrorResponse(warning);

      expect(matchesErrorDefinition(body, PARAMETER_WARNING_CODES.AMOUNT_MISSING)).toBe(false);
      expect(matchesErrorDefinition({ ...body, success: true })).toBe(false);
      expect(matchesErrorDefinition({ ...body, error: { ...body.error, httpStatus: 500 } })).toBe(false);
      expect(matchesErrorDefinition({ ...body, error: { ...body.error, summary: "other" } })).toBe(false);
      expect(matchesErrorDefinition({ ...body, error: { ...body.error, extra: 1 } })).toBe(false);
      expect(matchesErrorDefinition({ ...body, error: { ...body.error, message: "   " } })).toBe(false);
      expect(matchesErrorDefinition(null)).toBe(false);
      expect(matchesErrorDefinition("not a body")).toBe(false);
    });

    it("refuses to build a body for an unregistered code", () => {
      const warning = {
        code: "NOT_A_CODE",
        parameter: "amount",
        message: "m",
        index: null,
        calculationCode: null,
      } as unknown as ParameterWarning;

      expect(() => toErrorResponse(warning)).toThrow(/no error definition registered/);
    });
  });
});
