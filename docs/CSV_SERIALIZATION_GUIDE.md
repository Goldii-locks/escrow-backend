# CSV Serialization Guide for Partial Payment Allocator

## Overview

The CSV serializer module provides comprehensive functions to export payment allocations and formatted payment rows into CSV format. This is useful for data interchange, audit trails, reporting, and file exports.

## Features

- **Field Escaping**: Properly handles special characters (commas, quotes, newlines)
- **Timestamp Formatting**: Converts milliseconds to ISO 8601 format
- **Multiple Output Formats**: Minimal, detailed, full with summaries
- **CSV Validation**: Verify output structure and row counts
- **Bidirectional Conversion**: Parse CSV back to data structures
- **Statistical Reports**: Generate summary analytics

## Module Location

- **Implementation**: `src/utils/csv-serializer.ts`
- **Tests**: `__tests__/csv-serializer.test.ts`

## API Reference

### Field Escaping

#### `escapeCSVField(value: string | number | bigint): string`

Escapes a CSV field value to handle special characters.

**Rules:**
- If field contains comma, quote, or newline: wrap in double quotes
- Internal quotes are escaped by doubling them (`"` → `""`)
- Otherwise returned unchanged

**Examples:**
```typescript
escapeCSVField("hello, world")    // => '"hello, world"'
escapeCSVField('say "hi"')        // => '"say ""hi"""'
escapeCSVField("simple")          // => "simple"
escapeCSVField(123)               // => "123"
escapeCSVField(999999999999n)     // => "999999999999"
```

### Timestamp Formatting

#### `formatCSVTimestamp(timestamp: number): string`

Converts milliseconds since epoch to ISO 8601 format.

**Returns**: ISO 8601 formatted date string with millisecond precision

**Example:**
```typescript
formatCSVTimestamp(1695000000000)  // => "2023-09-18T00:40:00.000Z"
```

### Serialization Functions

#### `serializeFormattedRowsToCSV(rows, includeHeaders?, includeTimestamps?): string`

Serialize an array of `FormattedPaymentRow` to CSV.

**Parameters:**
- `rows`: Array of FormattedPaymentRow
- `includeHeaders`: Include CSV headers (default: true)
- `includeTimestamps`: Format timestamps to ISO 8601 (default: true)

**Output Format:**
```
milestone_index,total_amount,amount,recipient,processed_at,precision_preserved,original_value_bigint
0,1000000,500000,GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ,2023-09-18T00:40:00.000Z,true,500000
0,1000000,500000,GCEZWKSXI74DBESNZDG7DJT5NZR5WBNQ7NLROFQ2GDOA4YPSSXF3B5H2,2023-09-18T00:40:00.000Z,true,500000
```

**Throws:** Error if rows array is empty

**Example:**
```typescript
const rows: FormattedPaymentRow[] = [...];
const csv = serializeFormattedRowsToCSV(rows);
fs.writeFileSync('payments.csv', csv);
```

#### `serializeAllocationToCSV(allocation, includeSummary?, includeHeaders?): string`

Serialize a single `PaymentAllocation` to CSV with optional summary.

**Parameters:**
- `allocation`: PaymentAllocation to serialize
- `includeSummary`: Include allocation summary (default: true)
- `includeHeaders`: Include CSV headers (default: true)

**Output Format (with summary):**
```
milestone_index,recipient,amount,formatted_amount
0,GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ,500000,500000
0,GCEZWKSXI74DBESNZDG7DJT5NZR5WBNQ7NLROFQ2GDOA4YPSSXF3B5H2,500000,500000

===SUMMARY===
Milestone Index,Total Amount,Recipients Count,Created At
0,1000000,2,2023-09-18T00:40:00.000Z
```

**Throws:** Error if allocation is invalid or empty

**Example:**
```typescript
const result = allocatePayment(0, 1000000n, recipients);
if (result.success) {
  const csv = serializeAllocationToCSV(result.allocation);
  fs.writeFileSync(`allocation_${id}.csv`, csv);
}
```

#### `serializeAllocationsToCSV(allocations, includeHeaders?): string`

Serialize multiple `PaymentAllocation` objects to a combined CSV.

**Parameters:**
- `allocations`: Array of PaymentAllocation (can include optional `id` field)
- `includeHeaders`: Include CSV headers (default: true)

**Output Format:**
```
allocation_id,milestone_index,recipient,amount,formatted_amount,created_at
alloc_001,0,GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ,500000,500000,2023-09-18T00:40:00.000Z
alloc_001,0,GCEZWKSXI74DBESNZDG7DJT5NZR5WBNQ7NLROFQ2GDOA4YPSSXF3B5H2,500000,500000,2023-09-18T00:40:00.000Z
alloc_002,1,GBRPYHIL2CI3FV4BMSXIUVQTNOJ5NO4KJSVYWSCAP37N35MAXPESRGBQ,300000,300000,2023-09-18T00:41:00.000Z
```

**Features:**
- Auto-generates allocation IDs if not provided (`alloc_000`, `alloc_001`, etc.)
- Each allocation can have a custom `id` field
- All recipients from all allocations included

**Throws:** Error if allocations array is empty

**Example:**
```typescript
const allocations = [alloc1, alloc2, alloc3];
const csv = serializeAllocationsToCSV(allocations);
fs.writeFileSync('all_allocations.csv', csv);
```

#### `createAllocationSummaryCSV(allocations, includeHeaders?): string`

Create a summary report CSV with high-level statistics.

**Output Format:**
```
allocation_id,milestone_index,recipient_count,total_amount,status,created_at
alloc_000,0,2,1000000,pending,2023-09-18T00:40:00.000Z
alloc_001,1,3,500000,processed,2023-09-18T00:41:00.000Z
alloc_002,2,4,2000000,written,2023-09-18T00:42:00.000Z
```

**Example:**
```typescript
const summary = createAllocationSummaryCSV([alloc1, alloc2, alloc3]);
fs.writeFileSync('allocation_summary.csv', summary);
```

#### `generateAllocationStatisticsCSV(allocations): string`

Generate a statistical summary report.

**Output Format:**
```
Metric,Value
Total Allocations,3
Total Recipients,9
Total Amount Allocated,3500000
Average Recipients per Allocation,3.00
Average Amount per Allocation,1166666
```

**Useful For:**
- Audit reports
- Dashboard metrics
- Performance tracking
- Data validation checks

**Example:**
```typescript
const stats = generateAllocationStatisticsCSV(allocations);
console.log(stats);
```

### Validation and Parsing

#### `validateCSVOutput(csvContent, expectedRowCount?): ValidationResult`

Validate CSV output structure.

**Returns:**
```typescript
{
  valid: boolean;
  rowCount: number;
  error?: string;
  hasHeaders: boolean;
}
```

**Example:**
```typescript
const csv = serializeFormattedRowsToCSV(rows);
const validation = validateCSVOutput(csv, rows.length);

if (!validation.valid) {
  console.error('CSV validation failed:', validation.error);
} else {
  console.log(`Valid CSV with ${validation.rowCount} rows`);
}
```

#### `parseCSVContent(csvContent, skipHeaders?): string[][]`

Parse CSV content back into row arrays.

**Handles:**
- Quoted fields
- Escaped quotes (`""` → `"`)
- Commas within quoted fields
- Newlines within quoted fields

**Example:**
```typescript
const csv = serializeFormattedRowsToCSV(rows);
const parsed = parseCSVContent(csv, true);

for (const row of parsed) {
  console.log(row); // ['0', '1000000', '500000', 'address1', ...]
}
```

**Limitations:**
- Does not fully implement RFC 4180 (streaming support, etc.)
- Sufficient for typical payment allocation use cases

## Usage Examples

### Export Single Allocation

```typescript
import { allocatePayment } from './utils/partial-payment-allocator.js';
import { serializeAllocationToCSV } from './utils/csv-serializer.js';
import fs from 'fs';

const result = allocatePayment(
  0,
  1000000n,
  [
    { address: 'ADDR1', amount: 600000n },
    { address: 'ADDR2', amount: 400000n }
  ]
);

if (result.success) {
  const csv = serializeAllocationToCSV(result.allocation);
  fs.writeFileSync('allocation.csv', csv);
}
```

### Export Multiple Allocations

```typescript
import { serializeAllocationsToCSV } from './utils/csv-serializer.js';

const allocations = [alloc1, alloc2, alloc3];
const csv = serializeAllocationsToCSV(allocations);

fs.writeFileSync('all_allocations.csv', csv);
```

### Export Database Rows

```typescript
import { serializeFormattedRowsToCSV } from './utils/csv-serializer.js';

const rows: FormattedPaymentRow[] = await database.getPaymentRows();
const csv = serializeFormattedRowsToCSV(rows);

fs.writeFileSync('payment_records.csv', csv);
```

### Generate Reports

```typescript
import {
  createAllocationSummaryCSV,
  generateAllocationStatisticsCSV
} from './utils/csv-serializer.js';

// Summary report
const summary = createAllocationSummaryCSV(allocations);
fs.writeFileSync('summary.csv', summary);

// Statistics
const stats = generateAllocationStatisticsCSV(allocations);
fs.writeFileSync('statistics.csv', stats);
```

### Validate and Import

```typescript
import { validateCSVOutput, parseCSVContent } from './utils/csv-serializer.js';
import fs from 'fs';

const csvContent = fs.readFileSync('data.csv', 'utf-8');

// Validate
const validation = validateCSVOutput(csvContent);
if (!validation.valid) {
  throw new Error(`Invalid CSV: ${validation.error}`);
}

// Parse
const rows = parseCSVContent(csvContent, true);

for (const row of rows) {
  // Process each row
  console.log(row);
}
```

## CSV Format Specifications

### FormattedPaymentRow CSV

**Columns:**
1. `milestone_index` - Milestone number (integer)
2. `total_amount` - Total payment amount (string, no scientific notation)
3. `amount` - Individual share amount (string, no scientific notation)
4. `recipient` - Recipient address (Stellar format)
5. `processed_at` - Processing timestamp (ISO 8601)
6. `precision_preserved` - Whether precision was maintained (true/false)
7. `original_value_bigint` - Original BigInt value as string

**Precision:** All amounts stored as strings to preserve full precision (no floating-point)

### PaymentAllocation CSV

**Columns (Detail View):**
1. `milestone_index` - Milestone number (integer)
2. `recipient` - Recipient address
3. `amount` - BigInt amount as string
4. `formatted_amount` - Database-formatted amount

**Summary Section:**
- Milestone Index
- Total Amount
- Recipients Count
- Created At

### Combined Allocations CSV

**Columns:**
1. `allocation_id` - Unique allocation identifier
2. `milestone_index` - Milestone number
3. `recipient` - Recipient address
4. `amount` - BigInt amount as string
5. `formatted_amount` - Database-formatted amount
6. `created_at` - Allocation creation timestamp

### Summary Report CSV

**Columns:**
1. `allocation_id` - Unique allocation identifier
2. `milestone_index` - Milestone number
3. `recipient_count` - Number of recipients in this allocation
4. `total_amount` - Total allocated amount
5. `status` - Allocation status (pending/processed/written)
6. `created_at` - Creation timestamp

### Statistics Report CSV

**Rows (Key-Value):**
- Total Allocations
- Total Recipients
- Total Amount Allocated
- Average Recipients per Allocation
- Average Amount per Allocation

## CSV Field Escaping Rules

The CSV serializer follows standard CSV escaping conventions:

**Rule 1: Fields with Special Characters**
```
Original:  hello, world
Escaped:   "hello, world"
```

**Rule 2: Quotes**
```
Original:  say "hello"
Escaped:   "say ""hello"""
           (internal quotes are doubled)
```

**Rule 3: Newlines**
```
Original:  line1
           line2
Escaped:   "line1
           line2"
```

**Rule 4: Mixed Special Characters**
```
Original:  hello, "world"
           test
Escaped:   "hello, ""world""
           test"
```

## Error Handling

### Error Codes

```typescript
CSV_SERIALIZATION_ERRORS = {
  INVALID_ALLOCATION: "CSV_INVALID_ALLOCATION",
  EMPTY_ROWS: "CSV_EMPTY_ROWS",
  ESCAPE_FAILURE: "CSV_ESCAPE_FAILURE",
  INVALID_FORMAT: "CSV_INVALID_FORMAT",
  ENCODING_ERROR: "CSV_ENCODING_ERROR",
}
```

### Error Scenarios

**Empty Input Array**
```typescript
try {
  serializeFormattedRowsToCSV([]);
} catch (error) {
  // Error: CSV_EMPTY_ROWS
}
```

**Invalid Allocation**
```typescript
try {
  serializeAllocationToCSV({} as PaymentAllocation);
} catch (error) {
  // Error: CSV_INVALID_ALLOCATION
}
```

**Empty Allocations Array**
```typescript
try {
  createAllocationSummaryCSV([]);
} catch (error) {
  // Error: CSV_EMPTY_ROWS
}
```

## Testing

### Running Tests

```bash
npm test -- __tests__/csv-serializer.test.ts
```

### Test Coverage

The test suite includes 50+ tests covering:

1. **Field Escaping** (6 tests)
   - Simple fields
   - Fields with commas
   - Fields with quotes
   - Fields with newlines
   - Mixed special characters
   - BigInt values

2. **Timestamp Formatting** (3 tests)
   - ISO 8601 conversion
   - Different timestamps
   - Millisecond precision

3. **FormattedRows Serialization** (8 tests)
   - Single and multiple rows
   - Header inclusion/exclusion
   - Timestamp formatting
   - Special character escaping
   - Empty row handling

4. **Allocation Serialization** (6 tests)
   - Headers and summaries
   - All recipients included
   - Summary exclusion
   - Invalid allocations
   - Empty recipients

5. **Multiple Allocations** (4 tests)
   - Auto-generated and custom IDs
   - All recipients serialized
   - Empty array handling
   - Correct row counts

6. **Summary Reports** (3 tests)
   - Statistics included
   - Correct totals
   - Recipient counts

7. **Validation** (5 tests)
   - Valid CSV detection
   - Header detection
   - Row count validation
   - Empty CSV handling
   - No-header CSV support

8. **CSV Parsing** (6 tests)
   - Simple CSV parsing
   - Quoted fields
   - Escaped quotes
   - Commas in fields
   - Header skipping
   - Full row inclusion

9. **Statistics Generation** (4 tests)
   - Report generation
   - Correct totals
   - Recipient counting
   - Empty array handling

10. **Integration Tests** (5 tests)
    - Round-trip serialization/parsing
    - Allocation CSV validation
    - Complex scenarios
    - Output consistency

## Performance Considerations

### Memory Usage
- Linear with number of allocations and recipients
- ~1KB per average allocation (2-3 recipients)
- 1000 allocations ≈ 1-2MB of CSV

### Time Complexity
- O(n) where n = total recipients across all allocations
- Typical: <100ms for 10,000 recipients

### Optimization Tips

1. **Batch Processing**
   ```typescript
   // Instead of multiple small exports
   const csv = serializeAllocationsToCSV([...allocs]);
   
   // Instead of individual exports
   for (const alloc of allocs) {
     serializeAllocationToCSV(alloc);
   }
   ```

2. **Streaming Large Datasets**
   ```typescript
   // For very large files, write in chunks
   const stream = fs.createWriteStream('large_allocations.csv');
   
   stream.write(serializeFormattedRowsToCSV(rows.slice(0, 1000)));
   // ... more chunks ...
   stream.end();
   ```

3. **Avoid Redundant Formatting**
   ```typescript
   // Reuse CSV output instead of regenerating
   const csv = serializeAllocationsToCSV(allocations);
   fs.writeFileSync('file1.csv', csv);
   fs.writeFileSync('file2.csv', csv); // Same content
   ```

## Compliance

- Follows RFC 4180 CSV specification for common cases
- Compatible with Excel, Google Sheets, and standard CSV tools
- Supports international characters (UTF-8)
- Preserves full numeric precision (no scientific notation)

## Troubleshooting

### Issue: CSV doesn't open in Excel

**Solution:** Ensure file has UTF-8 BOM or is saved as CSV UTF-8

```typescript
const csv = serializeFormattedRowsToCSV(rows);
const bom = '\uFEFF';
fs.writeFileSync('payments.csv', bom + csv);
```

### Issue: Numbers displayed as text in spreadsheet

**Solution:** This is expected behavior for large numbers. Amounts are stored as strings to preserve precision.

### Issue: Special characters showing as gibberish

**Solution:** Ensure file is opened with UTF-8 encoding:
```typescript
const csv = serializeFormattedRowsToCSV(rows);
fs.writeFileSync('payments.csv', csv, 'utf-8');
```

## Best Practices

1. **Always Validate Output**
   ```typescript
   const csv = serializeFormattedRowsToCSV(rows);
   validateCSVOutput(csv, rows.length);
   ```

2. **Include Timestamps**
   - Helps with audit trails
   - Default behavior (recommended)

3. **Use Allocation IDs**
   - Makes tracking easier
   - Required for multi-allocation exports

4. **Regular Backups**
   - Export allocations regularly
   - Store in version control or archive

5. **Document Custom Fields**
   - If extending the format, document columns
   - Maintain backward compatibility

## Related Modules

- `src/utils/partial-payment-allocator.ts` - Core allocation logic
- `src/utils/fee-deduction-calculator.ts` - Fee calculations
- `src/middleware/partial-payment-allocator-rate-limit.ts` - Rate limiting
