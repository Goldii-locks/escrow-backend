import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  escapeCSVField,
  formatCSVTimestamp,
  serializeFormattedRowsToCSV,
  serializeAllocationToCSV,
  serializeAllocationsToCSV,
  createAllocationSummaryCSV,
  validateCSVOutput,
  parseCSVContent,
  generateAllocationStatisticsCSV,
  CSVSERIALIZER_ERRORS,
} from "../src/utils/csv-serializer.js";
import type { PaymentAllocation, FormattedPaymentRow } from "../src/utils/partial-payment-allocator.js";

// Mock data helpers
function createMockFormattedRow(overrides?: Partial<FormattedPaymentRow>): FormattedPaymentRow {
  return {
    milestone_index: 0,
    total_amount: "1000000",
    amount: "500000",
    recipient: "GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ",
    processed_at: Date.now(),
    precision_preserved: true,
    original_value_bigint: "500000",
    ...overrides,
  };
}

function createMockAllocation(overrides?: Partial<PaymentAllocation>): PaymentAllocation {
  return {
    milestoneIndex: 0,
    totalAmount: 1000000n,
    allocations: [
      {
        recipient: "GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ",
        amount: 500000n,
        formattedAmount: "500000",
      },
      {
        recipient: "GCEZWKSXI74DBESNZDG7DJT5NZR5WBNQ7NLROFQ2GDOA4YPSSXF3B5H2",
        amount: 500000n,
        formattedAmount: "500000",
      },
    ],
    metadata: {
      createdAt: 1695000000000,
      status: "pending",
    },
    ...overrides,
  };
}

describe("CSV Serializer", () => {
  describe("escapeCSVField", () => {
    it("should not escape fields without special characters", () => {
      expect(escapeCSVField("simple")).toBe("simple");
      expect(escapeCSVField(123)).toBe("123");
      expect(escapeCSVField(456789n)).toBe("456789");
    });

    it("should escape fields with commas", () => {
      expect(escapeCSVField("hello, world")).toBe('"hello, world"');
    });

    it("should escape fields with quotes", () => {
      expect(escapeCSVField('say "hi"')).toBe('"say ""hi"""');
    });

    it("should escape fields with newlines", () => {
      expect(escapeCSVField("line1\nline2")).toBe('"line1\nline2"');
    });

    it("should escape fields with multiple special characters", () => {
      expect(escapeCSVField('hello, "world"\ntest')).toBe('"hello, ""world""\ntest"');
    });

    it("should handle bigint values", () => {
      expect(escapeCSVField(999999999999n)).toBe("999999999999");
    });
  });

  describe("formatCSVTimestamp", () => {
    it("should convert milliseconds to ISO 8601 format", () => {
      const timestamp = 1695000000000; // 2023-09-18T01:20:00.000Z
      const formatted = formatCSVTimestamp(timestamp);
      expect(formatted).toBe("2023-09-18T01:20:00.000Z");
    });

    it("should handle different timestamps", () => {
      const timestamp = 1000000000000; // 2001-09-09T01:46:40.000Z
      const formatted = formatCSVTimestamp(timestamp);
      expect(formatted).toContain("2001-09-09");
    });

    it("should preserve millisecond precision", () => {
      const timestamp = 1695000000123;
      const formatted = formatCSVTimestamp(timestamp);
      expect(formatted).toBe("2023-09-18T01:20:00.123Z");
    });
  });

  describe("serializeFormattedRowsToCSV", () => {
    it("should serialize single row to CSV with headers", () => {
      const row = createMockFormattedRow();
      const csv = serializeFormattedRowsToCSV([row]);

      const lines = csv.split("\n");
      expect(lines.length).toBe(2); // header + 1 data row
      expect(lines[0]).toContain("milestone_index");
      expect(lines[0]).toContain("total_amount");
      expect(lines[0]).toContain("amount");
      expect(lines[0]).toContain("recipient");
    });

    it("should serialize multiple rows to CSV", () => {
      const rows = [
        createMockFormattedRow({ recipient: "ADDRESS1" }),
        createMockFormattedRow({ recipient: "ADDRESS2" }),
        createMockFormattedRow({ recipient: "ADDRESS3" }),
      ];
      const csv = serializeFormattedRowsToCSV(rows);

      const lines = csv.split("\n");
      expect(lines.length).toBe(4); // header + 3 data rows
    });

    it("should exclude headers when specified", () => {
      const rows = [createMockFormattedRow()];
      const csv = serializeFormattedRowsToCSV(rows, false);

      const lines = csv.split("\n");
      expect(lines.length).toBe(1); // Just data row
      expect(lines[0]).not.toContain("milestone_index");
    });

    it("should format timestamps in CSV output", () => {
      const row = createMockFormattedRow({ processed_at: 1695000000000 });
      const csv = serializeFormattedRowsToCSV([row], true, true);

      expect(csv).toContain("2023-09-18T01:20:00.000Z");
    });

    it("should throw error for empty rows array", () => {
      expect(() => serializeFormattedRowsToCSV([])).toThrow(
        CSVSERIALIZER_ERRORS.EMPTY_ROWS
      );
    });

    it("should escape special characters in CSV output", () => {
      const row = createMockFormattedRow({
        recipient: 'ADDRESS,"QUOTED",TEST',
      });
      const csv = serializeFormattedRowsToCSV([row]);

      expect(csv).toContain('"ADDRESS,""QUOTED"",TEST"');
    });
  });

  describe("serializeAllocationToCSV", () => {
    it("should serialize allocation with headers and summary", () => {
      const allocation = createMockAllocation();
      const csv = serializeAllocationToCSV(allocation);

      expect(csv).toContain("milestone_index,recipient,amount,formatted_amount");
      expect(csv).toContain("===SUMMARY===");
      expect(csv).toContain("Milestone Index,Total Amount,Recipients Count,Created At");
    });

    it("should include all recipients in output", () => {
      const allocation = createMockAllocation();
      const csv = serializeAllocationToCSV(allocation);

      expect(csv).toContain("GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ");
      expect(csv).toContain("GCEZWKSXI74DBESNZDG7DJT5NZR5WBNQ7NLROFQ2GDOA4YPSSXF3B5H2");
    });

    it("should exclude summary when specified", () => {
      const allocation = createMockAllocation();
      const csv = serializeAllocationToCSV(allocation, false);

      expect(csv).not.toContain("===SUMMARY===");
    });

    it("should exclude headers when specified", () => {
      const allocation = createMockAllocation();
      const csv = serializeAllocationToCSV(allocation, false, false);

      expect(csv).not.toContain("milestone_index,recipient");
    });

    it("should throw error for invalid allocation", () => {
      expect(() => serializeAllocationToCSV({} as PaymentAllocation)).toThrow(
        CSVSERIALIZER_ERRORS.INVALID_ALLOCATION
      );
    });

    it("should throw error for allocation with no recipients", () => {
      const allocation = createMockAllocation({ allocations: [] });
      expect(() => serializeAllocationToCSV(allocation)).toThrow(
        CSVSERIALIZER_ERRORS.INVALID_ALLOCATION
      );
    });
  });

  describe("serializeAllocationsToCSV", () => {
    it("should serialize multiple allocations with IDs", () => {
      const alloc1 = createMockAllocation({ milestoneIndex: 0 });
      const alloc2 = createMockAllocation({ milestoneIndex: 1 });
      const allocations = [
        { ...alloc1, id: "alloc_001" },
        { ...alloc2, id: "alloc_002" },
      ];

      const csv = serializeAllocationsToCSV(allocations);

      expect(csv).toContain("allocation_id,milestone_index");
      expect(csv).toContain("alloc_001");
      expect(csv).toContain("alloc_002");
    });

    it("should auto-generate IDs if not provided", () => {
      const allocations = [
        createMockAllocation(),
        createMockAllocation(),
      ];

      const csv = serializeAllocationsToCSV(allocations);

      expect(csv).toContain("alloc_000");
      expect(csv).toContain("alloc_001");
    });

    it("should throw error for empty allocations array", () => {
      expect(() => serializeAllocationsToCSV([])).toThrow(
        CSVSERIALIZER_ERRORS.EMPTY_ROWS
      );
    });

    it("should serialize all recipients from all allocations", () => {
      const alloc1 = createMockAllocation({ milestoneIndex: 0 });
      const alloc2 = createMockAllocation({ milestoneIndex: 1 });

      const csv = serializeAllocationsToCSV([alloc1, alloc2]);

      // Should have 5 lines: header + 2 from alloc1 + 2 from alloc2
      const lines = csv.split("\n");
      expect(lines.length).toBe(5);
    });
  });

  describe("createAllocationSummaryCSV", () => {
    it("should create summary with statistics", () => {
      const allocations = [
        createMockAllocation({ milestoneIndex: 0 }),
        createMockAllocation({ milestoneIndex: 1 }),
      ];

      const csv = createAllocationSummaryCSV(allocations);

      expect(csv).toContain("allocation_id,milestone_index,recipient_count");
      expect(csv).toContain("2"); // milestone_index values
    });

    it("should include correct recipient counts", () => {
      const alloc1 = createMockAllocation({
        allocations: Array(3).fill(null).map((_, i) => ({
          recipient: `ADDRESS${i}`,
          amount: 100000n,
          formattedAmount: "100000",
        })),
      });

      const csv = createAllocationSummaryCSV([alloc1]);

      expect(csv).toContain("3"); // 3 recipients
    });

    it("should include total amounts", () => {
      const allocations = [
        createMockAllocation({ totalAmount: 5000000n }),
      ];

      const csv = createAllocationSummaryCSV(allocations);

      expect(csv).toContain("5000000");
    });

    it("should include status information", () => {
      const allocations = [
        createMockAllocation({ metadata: { createdAt: Date.now(), status: "processed" } }),
      ];

      const csv = createAllocationSummaryCSV(allocations);

      expect(csv).toContain("processed");
    });
  });

  describe("validateCSVOutput", () => {
    it("should validate correct CSV output", () => {
      const rows = [
        createMockFormattedRow(),
        createMockFormattedRow(),
      ];
      const csv = serializeFormattedRowsToCSV(rows);

      const result = validateCSVOutput(csv, 2);

      expect(result.valid).toBe(true);
      expect(result.rowCount).toBe(2);
      expect(result.hasHeaders).toBe(true);
    });

    it("should detect header presence", () => {
      const csv = "header1,header2\nvalue1,value2";
      const result = validateCSVOutput(csv);

      expect(result.hasHeaders).toBe(true);
    });

    it("should reject CSV with wrong row count", () => {
      const rows = [createMockFormattedRow()];
      const csv = serializeFormattedRowsToCSV(rows);

      const result = validateCSVOutput(csv, 5);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Expected 5 rows");
    });

    it("should reject empty CSV", () => {
      const result = validateCSVOutput("");

      expect(result.valid).toBe(false);
      expect(result.rowCount).toBe(0);
    });

    it("should validate CSV without headers", () => {
      const rows = [createMockFormattedRow()];
      const csv = serializeFormattedRowsToCSV(rows, false);

      const result = validateCSVOutput(csv, 1);

      expect(result.valid).toBe(true);
      expect(result.hasHeaders).toBe(false);
    });
  });

  describe("parseCSVContent", () => {
    it("should parse simple CSV content", () => {
      const csv = "col1,col2,col3\nval1,val2,val3\nval4,val5,val6";
      const parsed = parseCSVContent(csv, true);

      expect(parsed.length).toBe(2); // 2 data rows (skip header)
      expect(parsed[0][0]).toBe("val1");
      expect(parsed[1][0]).toBe("val4");
    });

    it("should handle quoted fields", () => {
      const csv = 'header\n"field1","field2","field3"';
      const parsed = parseCSVContent(csv, true);

      expect(parsed.length).toBe(1);
      expect(parsed[0][0]).toBe("field1");
    });

    it("should handle escaped quotes in fields", () => {
      const csv = 'header\n"say ""hello""","world"';
      const parsed = parseCSVContent(csv, true);

      expect(parsed[0][0]).toBe('say "hello"');
    });

    it("should handle commas in quoted fields", () => {
      const csv = 'header\n"hello, world","test"';
      const parsed = parseCSVContent(csv, true);

      expect(parsed[0][0]).toBe("hello, world");
    });

    it("should skip headers when specified", () => {
      const csv = "header1,header2\ndata1,data2";
      const parsed = parseCSVContent(csv, true);

      expect(parsed.length).toBe(1);
      expect(parsed[0][0]).toBe("data1");
    });

    it("should include all rows when skipHeaders is false", () => {
      const csv = "header1,header2\ndata1,data2";
      const parsed = parseCSVContent(csv, false);

      expect(parsed.length).toBe(2);
      expect(parsed[0][0]).toBe("header1");
    });
  });

  describe("generateAllocationStatisticsCSV", () => {
    it("should generate statistics report", () => {
      const allocations = [
        createMockAllocation(),
        createMockAllocation(),
      ];

      const csv = generateAllocationStatisticsCSV(allocations);

      expect(csv).toContain("Metric,Value");
      expect(csv).toContain("Total Allocations,2");
    });

    it("should calculate correct totals", () => {
      const allocations = [
        createMockAllocation({ totalAmount: 1000000n }),
        createMockAllocation({ totalAmount: 2000000n }),
      ];

      const csv = generateAllocationStatisticsCSV(allocations);

      expect(csv).toContain("Total Amount Allocated,3000000");
    });

    it("should calculate correct recipient count", () => {
      const allocations = [
        createMockAllocation({
          allocations: Array(5).fill(null).map((_, i) => ({
            recipient: `ADDR${i}`,
            amount: 100000n,
            formattedAmount: "100000",
          })),
        }),
      ];

      const csv = generateAllocationStatisticsCSV(allocations);

      expect(csv).toContain("Total Recipients,5");
    });

    it("should throw error for empty allocations", () => {
      expect(() => generateAllocationStatisticsCSV([])).toThrow(
        CSVSERIALIZER_ERRORS.EMPTY_ROWS
      );
    });
  });

  describe("Integration Tests", () => {
    it("should round-trip: serialize and parse CSV", () => {
      const rows = [
        createMockFormattedRow({ recipient: "ADDR1" }),
        createMockFormattedRow({ recipient: "ADDR2" }),
      ];

      const csv = serializeFormattedRowsToCSV(rows);
      const parsed = parseCSVContent(csv, true);

      expect(parsed.length).toBe(2);
      expect(parsed[0]).toContain("ADDR1");
      expect(parsed[1]).toContain("ADDR2");
    });

    it("should validate and parse allocation CSV", () => {
      const allocation = createMockAllocation();
      const csv = serializeAllocationToCSV(allocation, false, true);

      const validation = validateCSVOutput(csv, 2);
      expect(validation.valid).toBe(true);

      const parsed = parseCSVContent(csv, true);
      expect(parsed.length).toBe(2); // 2 recipients
    });

    it("should handle complex allocation scenarios", () => {
      const allocations = Array(5).fill(null).map((_, idx) =>
        createMockAllocation({
          milestoneIndex: idx,
          totalAmount: BigInt(1000000 * (idx + 1)),
          allocations: Array(idx + 2).fill(null).map((_, recipientIdx) => ({
            recipient: `ADDRESS_${idx}_${recipientIdx}`,
            amount: BigInt(Math.floor(1000000 / (idx + 2))),
            formattedAmount: String(Math.floor(1000000 / (idx + 2))),
          })),
        })
      );

      const csv = serializeAllocationsToCSV(allocations);
      const validation = validateCSVOutput(csv);

      expect(validation.valid).toBe(true);
      expect(validation.rowCount).toBeGreaterThan(0);
    });

    it("should generate consistent output across multiple calls", () => {
      const allocation = createMockAllocation();

      const csv1 = serializeAllocationToCSV(allocation);
      const csv2 = serializeAllocationToCSV(allocation);

      expect(csv1).toBe(csv2);
    });
  });
});
