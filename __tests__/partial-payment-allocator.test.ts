import {
  allocatePayment,
  formatAmountForDatabase,
  parseAmountFromDatabase,
  validatePrecisionPreservation,
  formatPaymentRowForDatabase,
  validateMilestoneIndex,
  validateRecipient,
  verifyFormattedPayments,
  getFormattedPaymentRows,
  markAllocationProcessed,
  markAllocationWritten,
  PAYMENT_ALLOCATION_ERRORS,
  type PaymentAllocation,
  type FormattedPaymentRow,
} from "../src/utils/partial-payment-allocator.js";

describe("Partial Payment Allocator – Database Precision Formatting", () => {
  describe("formatAmountForDatabase – format BigInt for storage", () => {
    it("converts BigInt to string without precision loss", () => {
      const amount = 1234567890n;
      const formatted = formatAmountForDatabase(amount);

      expect(formatted).toBe("1234567890");
      expect(typeof formatted).toBe("string");
    });

    it("handles very large amounts", () => {
      const amount = BigInt("9007199254740991"); // Number.MAX_SAFE_INTEGER
      const formatted = formatAmountForDatabase(amount);

      expect(formatted).toBe("9007199254740991");
      expect(formatted).not.toContain("e");
      expect(formatted).not.toContain("E");
    });

    it("avoids scientific notation", () => {
      const amount = BigInt("100000000000000");
      const formatted = formatAmountForDatabase(amount);

      expect(formatted).not.toMatch(/e|E/);
      expect(formatted).toBe("100000000000000");
    });

    it("handles zero", () => {
      const amount = 0n;
      const formatted = formatAmountForDatabase(amount);

      expect(formatted).toBe("0");
    });

    it("handles one", () => {
      const amount = 1n;
      const formatted = formatAmountForDatabase(amount);

      expect(formatted).toBe("1");
    });

    it("preserves leading zeros in calculations", () => {
      // After division or calculations, ensure no precision loss
      const amount = 100n;
      const formatted = formatAmountForDatabase(amount);

      expect(formatted).toBe("100");
    });
  });

  describe("parseAmountFromDatabase – parse stored values", () => {
    it("parses string to BigInt correctly", () => {
      const formatted = "1234567890";
      const parsed = parseAmountFromDatabase(formatted);

      expect(parsed).toBe(1234567890n);
    });

    it("handles large numbers from database", () => {
      const formatted = "9007199254740991";
      const parsed = parseAmountFromDatabase(formatted);

      expect(parsed).toBe(9007199254740991n);
    });

    it("throws on invalid format", () => {
      expect(() => parseAmountFromDatabase("not-a-number")).toThrow();
      expect(() => parseAmountFromDatabase("123abc")).toThrow();
    });

    it("handles zero", () => {
      const parsed = parseAmountFromDatabase("0");
      expect(parsed).toBe(0n);
    });
  });

  describe("validatePrecisionPreservation – round-trip validation", () => {
    it("confirms precision preserved for exact match", () => {
      const original = 1000n;
      const formatted = formatAmountForDatabase(original);

      const result = validatePrecisionPreservation(original, formatted);
      expect(result.ok).toBe(true);
      expect(result.precisionLoss).toBe(false);
    });

    it("detects precision loss on mismatch", () => {
      const original = 1000n;
      const formatted = "999"; // Intentional mismatch

      const result = validatePrecisionPreservation(original, formatted);
      expect(result.ok).toBe(true);
      expect(result.precisionLoss).toBe(true);
    });

    it("returns ok false for invalid format", () => {
      const original = 1000n;
      const formatted = "invalid";

      const result = validatePrecisionPreservation(original, formatted);
      expect(result.ok).toBe(false);
      expect(result.precisionLoss).toBe(true);
    });

    it("handles very large amounts", () => {
      const original = BigInt("9007199254740991");
      const formatted = formatAmountForDatabase(original);

      const result = validatePrecisionPreservation(original, formatted);
      expect(result.ok).toBe(true);
      expect(result.precisionLoss).toBe(false);
    });
  });

  describe("formatPaymentRowForDatabase – complete row formatting", () => {
    it("creates formatted row with all required fields", () => {
      const row = formatPaymentRowForDatabase(
        0,
        1000n,
        "GAAAA...AAAA",
        500n
      );

      expect(row.milestone_index).toBe(0);
      expect(row.total_amount).toBe("1000");
      expect(row.amount).toBe("500");
      expect(row.recipient).toBe("GAAAA...AAAA");
      expect(row.processed_at).toBeGreaterThan(0);
      expect(row.precision_preserved).toBe(true);
      expect(row.original_value_bigint).toBe("500");
    });

    it("formats large amounts without scientific notation", () => {
      const row = formatPaymentRowForDatabase(
        0,
        BigInt("100000000000000"),
        "GAAAA...AAAA",
        BigInt("50000000000000")
      );

      expect(row.total_amount).not.toMatch(/e|E/);
      expect(row.amount).not.toMatch(/e|E/);
      expect(row.total_amount).toBe("100000000000000");
      expect(row.amount).toBe("50000000000000");
    });

    it("preserves precision through formatting", () => {
      const amount = 123456789n;
      const row = formatPaymentRowForDatabase(
        0,
        amount,
        "GAAAA...AAAA",
        amount
      );

      const parsed = BigInt(row.amount);
      expect(parsed).toBe(amount);
    });
  });

  describe("validateMilestoneIndex – milestone validation", () => {
    it("accepts valid non-negative integer", () => {
      const result = validateMilestoneIndex(0);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(0);
    });

    it("accepts positive integer", () => {
      const result = validateMilestoneIndex(5);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(5);
    });

    it("rejects negative number", () => {
      const result = validateMilestoneIndex(-1);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.INVALID_MILESTONE_INDEX);
    });

    it("rejects decimal number", () => {
      const result = validateMilestoneIndex(1.5);
      expect(result.ok).toBe(false);
    });

    it("rejects string", () => {
      const result = validateMilestoneIndex("0");
      expect(result.ok).toBe(false);
    });

    it("rejects null", () => {
      const result = validateMilestoneIndex(null);
      expect(result.ok).toBe(false);
    });
  });

  describe("validateRecipient – recipient validation", () => {
    it("accepts valid stellar address", () => {
      const result = validateRecipient("GAAAA...AAAA");
      expect(result.ok).toBe(true);
    });

    it("rejects empty string", () => {
      const result = validateRecipient("");
      expect(result.ok).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.INVALID_RECIPIENT);
    });

    it("rejects non-string", () => {
      const result = validateRecipient(123);
      expect(result.ok).toBe(false);
    });

    it("rejects null", () => {
      const result = validateRecipient(null);
      expect(result.ok).toBe(false);
    });

    it("accepts whitespace-containing addresses", () => {
      const result = validateRecipient("G AAA");
      expect(result.ok).toBe(true); // Format validation is separate
    });
  });

  describe("allocatePayment – complete payment allocation", () => {
    it("allocates payment across multiple recipients correctly", () => {
      const result = allocatePayment(
        0,
        1000n,
        [
          { address: "GAAAA...AAAA", amount: 600n },
          { address: "GBBBB...BBBB", amount: 400n },
        ]
      );

      expect(result.success).toBe(true);
      expect(result.allocation?.totalAmount).toBe(1000n);
      expect(result.allocation?.allocations).toHaveLength(2);
      expect(result.formatted).toHaveLength(2);
      expect(result.precisionLoss).toBe(false);
    });

    it("rejects when allocations don't sum to total", () => {
      const result = allocatePayment(
        0,
        1000n,
        [
          { address: "GAAAA...AAAA", amount: 600n },
          { address: "GBBBB...BBBB", amount: 300n }, // Sum = 900
        ]
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.ALLOCATION_MISMATCH);
    });

    it("rejects with invalid milestone index", () => {
      const result = allocatePayment(
        -1, // Invalid
        1000n,
        [{ address: "GAAAA...AAAA", amount: 1000n }]
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.INVALID_MILESTONE_INDEX);
    });

    it("rejects with invalid total amount", () => {
      const result = allocatePayment(
        0,
        -1000, // Negative
        [{ address: "GAAAA...AAAA", amount: 1000n }]
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.INVALID_AMOUNT);
    });

    it("rejects with empty recipient list", () => {
      const result = allocatePayment(0, 1000n, []);

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.EMPTY_ALLOCATIONS);
    });

    it("rejects with invalid recipient", () => {
      const result = allocatePayment(
        0,
        1000n,
        [
          { address: "", amount: 1000n }, // Empty recipient
        ]
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.INVALID_RECIPIENT);
    });

    it("rejects when any allocation exceeds total", () => {
      const result = allocatePayment(
        0,
        1000n,
        [
          { address: "GAAAA...AAAA", amount: 1500n }, // Exceeds total
        ]
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.INVALID_AMOUNT);
    });

    it("rejects with negative recipient amount", () => {
      const result = allocatePayment(
        0,
        1000n,
        [
          { address: "GAAAA...AAAA", amount: -100n }, // Negative
        ]
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe(PAYMENT_ALLOCATION_ERRORS.NEGATIVE_AMOUNT);
    });

    it("handles large amounts with full precision", () => {
      const largeAmount = BigInt("9007199254740991");
      const result = allocatePayment(
        0,
        largeAmount,
        [{ address: "GAAAA...AAAA", amount: largeAmount }]
      );

      expect(result.success).toBe(true);
      expect(result.allocation?.totalAmount).toBe(largeAmount);
      expect(result.formatted?.[0].amount).toBe(largeAmount.toString());
    });

    it("handles many recipients", () => {
      const recipients = Array.from({ length: 100 }, (_, i) => ({
        address: `G${"A".repeat(52)}${i.toString().padStart(3, "0")}`,
        amount: 10n,
      }));

      const result = allocatePayment(0, 1000n, recipients);

      expect(result.success).toBe(true);
      expect(result.formatted).toHaveLength(100);
    });

    it("formats all rows with correct metadata", () => {
      const result = allocatePayment(
        5,
        1000n,
        [
          { address: "GAAAA...AAAA", amount: 600n },
          { address: "GBBBB...BBBB", amount: 400n },
        ]
      );

      expect(result.formatted).toBeDefined();
      result.formatted?.forEach((row) => {
        expect(row.milestone_index).toBe(5);
        expect(row.total_amount).toBe("1000");
        expect(row.processed_at).toBeGreaterThan(0);
        expect(row.precision_preserved).toBe(true);
      });
    });
  });

  describe("verifyFormattedPayments – verify row consistency", () => {
    it("confirms valid formatted payments", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 600n, formattedAmount: "600" },
          { recipient: "GBBBB...BBBB", amount: 400n, formattedAmount: "400" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const formatted = getFormattedPaymentRows(allocation);
      const result = verifyFormattedPayments(allocation, formatted);

      expect(result.ok).toBe(true);
      expect(result.precisionPreserved).toBe(true);
    });

    it("detects row count mismatch", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const formatted: FormattedPaymentRow[] = []; // Empty

      const result = verifyFormattedPayments(allocation, formatted);
      expect(result.ok).toBe(false);
    });

    it("detects milestone index mismatch", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const formatted: FormattedPaymentRow[] = [
        {
          milestone_index: 1, // Mismatch
          total_amount: "1000",
          amount: "1000",
          recipient: "GAAAA...AAAA",
          processed_at: Date.now(),
          precision_preserved: true,
          original_value_bigint: "1000",
        },
      ];

      const result = verifyFormattedPayments(allocation, formatted);
      expect(result.ok).toBe(false);
    });

    it("detects recipient mismatch", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const formatted: FormattedPaymentRow[] = [
        {
          milestone_index: 0,
          total_amount: "1000",
          amount: "1000",
          recipient: "GBBBB...BBBB", // Mismatch
          processed_at: Date.now(),
          precision_preserved: true,
          original_value_bigint: "1000",
        },
      ];

      const result = verifyFormattedPayments(allocation, formatted);
      expect(result.ok).toBe(false);
    });

    it("detects amount format mismatch", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const formatted: FormattedPaymentRow[] = [
        {
          milestone_index: 0,
          total_amount: "1000",
          amount: "999", // Mismatch
          recipient: "GAAAA...AAAA",
          processed_at: Date.now(),
          precision_preserved: true,
          original_value_bigint: "1000",
        },
      ];

      const result = verifyFormattedPayments(allocation, formatted);
      expect(result.ok).toBe(false);
    });

    it("detects precision flag mismatch", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const formatted: FormattedPaymentRow[] = [
        {
          milestone_index: 0,
          total_amount: "1000",
          amount: "1000",
          recipient: "GAAAA...AAAA",
          processed_at: Date.now(),
          precision_preserved: false, // Should be true
          original_value_bigint: "1000",
        },
      ];

      const result = verifyFormattedPayments(allocation, formatted);
      expect(result.ok).toBe(false);
    });
  });

  describe("getFormattedPaymentRows – extract rows from allocation", () => {
    it("extracts all formatted rows", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 600n, formattedAmount: "600" },
          { recipient: "GBBBB...BBBB", amount: 400n, formattedAmount: "400" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const rows = getFormattedPaymentRows(allocation);

      expect(rows).toHaveLength(2);
      expect(rows[0].amount).toBe("600");
      expect(rows[1].amount).toBe("400");
    });
  });

  describe("markAllocationProcessed – track processing state", () => {
    it("marks allocation as processed", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "pending",
        },
      };

      const processed = markAllocationProcessed(allocation);

      expect(processed.metadata.status).toBe("processed");
      expect(processed.metadata.processedAt).toBeGreaterThan(0);
    });
  });

  describe("markAllocationWritten – track write completion", () => {
    it("marks allocation as written", () => {
      const allocation: PaymentAllocation = {
        milestoneIndex: 0,
        totalAmount: 1000n,
        allocations: [
          { recipient: "GAAAA...AAAA", amount: 1000n, formattedAmount: "1000" },
        ],
        metadata: {
          createdAt: Date.now(),
          status: "processed",
        },
      };

      const written = markAllocationWritten(allocation);

      expect(written.metadata.status).toBe("written");
    });
  });

  describe("Full workflow – allocation to database write", () => {
    it("complete flow preserves precision through formatting and verification", () => {
      // 1. Allocate payment
      const allocResult = allocatePayment(
        0,
        BigInt("1000000"),
        [
          { address: "GAAAA...AAAA", amount: 600000n },
          { address: "GBBBB...BBBB", amount: 400000n },
        ]
      );

      expect(allocResult.success).toBe(true);

      // 2. Get formatted rows
      const allocation = allocResult.allocation!;
      const rows = getFormattedPaymentRows(allocation);

      // 3. Verify formatted rows
      const verifyResult = verifyFormattedPayments(allocation, rows);
      expect(verifyResult.ok).toBe(true);
      expect(verifyResult.precisionPreserved).toBe(true);

      // 4. Mark as processed
      const processed = markAllocationProcessed(allocation);
      expect(processed.metadata.status).toBe("processed");

      // 5. Mark as written (after DB write succeeds)
      const written = markAllocationWritten(processed);
      expect(written.metadata.status).toBe("written");

      // 6. Verify no precision loss through entire process
      rows.forEach((row) => {
        const parsed = BigInt(row.amount);
        const original = allocation.allocations.find(
          (a) => a.recipient === row.recipient
        )?.amount;
        expect(parsed).toBe(original);
      });
    });

    it("detects and rejects precision loss early", () => {
      const result = allocatePayment(
        0,
        BigInt("9007199254740991"), // MAX_SAFE_INTEGER
        [
          {
            address: "GAAAA...AAAA",
            amount: BigInt("9007199254740991"),
          },
        ]
      );

      expect(result.success).toBe(true);
      expect(result.precisionLoss).toBe(false);

      // Verify formatted rows maintain precision
      const rows = result.formatted!;
      rows.forEach((row) => {
        expect(row.precision_preserved).toBe(true);
        const parsed = BigInt(row.amount);
        expect(parsed).toBe(BigInt("9007199254740991"));
      });
    });
  });

  describe("Precision preservation guarantees", () => {
    it("round-trip conversion preserves exact values", () => {
      const testAmounts = [
        1n,
        100n,
        1000000n,
        BigInt("9007199254740991"), // MAX_SAFE_INTEGER
      ];

      for (const amount of testAmounts) {
        const formatted = formatAmountForDatabase(amount);
        const parsed = parseAmountFromDatabase(formatted);
        expect(parsed).toBe(amount);
      }
    });

    it("maintains precision with multiple allocations", () => {
      const total = 1000000n;
      const recipients = Array.from({ length: 10 }, (_, i) => ({
        address: `G${"A".repeat(52)}${i.toString().padStart(3, "0")}`,
        amount: BigInt(Math.floor(1000000 / 10) + (i === 0 ? 1000000 % 10 : 0)),
      }));

      const result = allocatePayment(0, total, recipients);

      expect(result.success).toBe(true);

      // Verify sum through formatted rows
      let sum = 0n;
      result.formatted?.forEach((row) => {
        sum += BigInt(row.amount);
      });
      expect(sum).toBe(total);
    });
  });
});
