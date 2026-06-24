# Bugfix Requirements Document

## Introduction

The `GET /api/jobs/:contractId/whitelist` route handler in `src/routes/jobs.ts` contains four response-consistency bugs and is missing input validation and test coverage. These defects cause the endpoint to return the wrong HTTP envelope shape on success, a misleading HTTP 200 success response when the contract is uninitialized, and raw `res.status().json()` calls instead of the project-standard `sendError()` / `sendSuccess()` utilities. Additionally, the endpoint never validates `contractId` before forwarding it to the Stellar SDK, producing cryptic internal errors for malformed addresses. No test file exists for this endpoint.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the whitelist simulation succeeds and returns a token list THEN the system returns `{ success: true, tokens: [...] }` (tokens at top level) instead of the project-standard envelope `{ success: true, data: { tokens: [...] } }`

1.2 WHEN the Stellar RPC simulation returns `contract error #2` or `NotInitialized` THEN the system returns HTTP 200 with `{ success: true, tokens: [] }`, silently misrepresenting an unusable-contract state as a successful empty result

1.3 WHEN the simulation returns an unexpected error (not NotInitialized) THEN the system calls `res.status(500).json(...)` directly, bypassing the `sendError()` utility that all other handlers in the file use

1.4 WHEN the `catch` block is triggered by an RPC or SDK exception THEN the system calls `res.status(500).json(...)` directly, bypassing the `sendError()` utility

1.5 WHEN `contractId` is not a valid Stellar contract address THEN the system passes the raw value to the Stellar SDK, which produces a cryptic internal error rather than a clean HTTP 400 response

### Expected Behavior (Correct)

2.1 WHEN the whitelist simulation succeeds and returns a token list THEN the system SHALL return HTTP 200 with `sendSuccess(res, { tokens: [...] })`, producing `{ success: true, data: { tokens: [...] } }`

2.2 WHEN the Stellar RPC simulation returns `contract error #2` or `NotInitialized` THEN the system SHALL return HTTP 422 with `sendError(res, 422, "Contract is not initialized")`, conveying that the contract exists but is not in a usable state

2.3 WHEN the simulation returns an unexpected error (not NotInitialized) THEN the system SHALL call `sendError(res, 500, errorMsg)` to produce a consistent `{ success: false, error: "..." }` envelope

2.4 WHEN the `catch` block is triggered by an RPC or SDK exception THEN the system SHALL call `sendError(res, 500, err.message)` to produce a consistent `{ success: false, error: "..." }` envelope

2.5 WHEN `contractId` is not a valid Stellar contract address THEN the system SHALL return HTTP 400 with `sendError(res, 400, "contractId must be a valid Stellar contract address (C...)")` before making any RPC call

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `contractId` is a valid Stellar contract address THEN the system SHALL CONTINUE TO forward the request to the Stellar RPC `simulateTransaction` call

3.2 WHEN the simulation succeeds and `result.result.retval` is iterable THEN the system SHALL CONTINUE TO iterate over the returned vec and collect each token as a string

3.3 WHEN the simulation returns an error that is neither `contract error #2` nor `NotInitialized` THEN the system SHALL CONTINUE TO treat the response as an internal server error

3.4 WHEN the simulation result contains no retval THEN the system SHALL CONTINUE TO treat the response as an internal server error (HTTP 500)

3.5 WHEN a valid request is made to any other route handler in `src/routes/jobs.ts` THEN those handlers SHALL CONTINUE TO behave exactly as before — this fix is scoped solely to the `GET /:contractId/whitelist` handler

---

## Bug Condition Pseudocode

### Bug Condition Functions

**Bug 1 — Wrong envelope shape (success path):**
```pascal
FUNCTION isBugCondition_1(X)
  INPUT: X — simulateTransaction result
  OUTPUT: boolean

  RETURN "result" IN X AND X.result.retval IS iterable
END FUNCTION
```

**Bug 2 — Wrong status for uninitialized contract:**
```pascal
FUNCTION isBugCondition_2(X)
  INPUT: X — simulateTransaction result
  OUTPUT: boolean

  RETURN "error" IN X AND
         (X.error INCLUDES "contract error #2" OR X.error INCLUDES "NotInitialized")
END FUNCTION
```

**Bug 3 & 4 — Raw res.status().json() instead of sendError():**
```pascal
FUNCTION isBugCondition_3(X)
  INPUT: X — simulateTransaction result or thrown exception
  OUTPUT: boolean

  RETURN ("error" IN X AND NOT isBugCondition_2(X)) OR X IS exception
END FUNCTION
```

**Bug 5 — Missing input validation:**
```pascal
FUNCTION isBugCondition_5(X)
  INPUT: X — contractId string from req.params
  OUTPUT: boolean

  RETURN NOT isValidStellarContractId(X)
END FUNCTION
```

### Fix-Checking Properties

```pascal
// Property: Fix Checking — Correct envelope shape
FOR ALL X WHERE isBugCondition_1(X) DO
  result ← getWhitelist'(X)
  ASSERT result.status = 200
  ASSERT result.body = { success: true, data: { tokens: [...] } }
END FOR

// Property: Fix Checking — NotInitialized returns 422
FOR ALL X WHERE isBugCondition_2(X) DO
  result ← getWhitelist'(X)
  ASSERT result.status = 422
  ASSERT result.body = { success: false, error: "Contract is not initialized" }
END FOR

// Property: Fix Checking — Errors use sendError()
FOR ALL X WHERE isBugCondition_3(X) DO
  result ← getWhitelist'(X)
  ASSERT result.body MATCHES { success: false, error: string }
  ASSERT result.status IN { 500 }
END FOR

// Property: Fix Checking — Invalid contractId rejected early
FOR ALL X WHERE isBugCondition_5(X) DO
  result ← getWhitelist'(X)
  ASSERT result.status = 400
  ASSERT result.body = { success: false, error: "contractId must be a valid Stellar contract address (C...)" }
  ASSERT simulateTransaction WAS NOT CALLED
END FOR
```

### Preservation Property

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT (isBugCondition_1(X) OR isBugCondition_2(X) OR
                     isBugCondition_3(X) OR isBugCondition_5(X)) DO
  ASSERT getWhitelist(X) = getWhitelist'(X)
END FOR
```
