# Partial Payment Allocator Rate Limiting

## Overview

This document describes the rate limiting implementation for the partial payment allocator feature. Rate limiting protects against abuse by limiting the number of requests clients can make within a specified time window.

## Implementation Details

### Location
- **Middleware**: `src/middleware/job-contract-rate-limit.ts`
- **Wrapper**: `src/middleware/partial-payment-allocator-rate-limit.ts`
- **Tests**: `__tests__/partial-payment-allocator-rate-limit.test.ts`
- **Example Routes**: `src/routes/partial-payment-allocator-example.ts`

### Rate Limiting Strategy

**IP-Based Bucketing**: Each client IP address gets its own request bucket with a counter and reset timestamp.

**Time Windows**: Requests are tracked in configurable time windows (default: 60 seconds).

**Per-Window Limits**: Each client can make a configurable number of requests per window (default: 50 requests).

**Automatic Window Reset**: When the window expires, the bucket is reset for the next period.

### Key Functions

#### `partialPaymentAllocatorRateLimit(req, res, next)`
Main rate limiting middleware function.

**Behavior:**
1. Resolves client IP from `req.ip` or `req.socket.remoteAddress`
2. Checks if client has an active bucket
3. Increments request counter
4. Returns rate limit headers (`X-RateLimit-*`)
5. Rejects requests exceeding the limit with 429 status

**Rate Limit Headers:**
- `X-RateLimit-Limit`: Maximum requests allowed in the window
- `X-RateLimit-Remaining`: Requests remaining in current window
- `X-RateLimit-Reset`: Unix timestamp when window resets

#### `partialPaymentAllocatorRateLimitMiddleware(req, res, next)`
Convenient wrapper exported for use in routes.

#### `resetPartialPaymentAllocatorRateLimitBuckets()`
Clears all client buckets. Used primarily for testing.

### Configuration

Rate limiting is configured through environment variables:

```env
# Maximum requests per time window (default: 50)
PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX=50

# Time window in milliseconds (default: 60000 = 60 seconds)
PARTIAL_PAYMENT_ALLOCATOR_RATE_WINDOW_MS=60000
```

### Default Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| Requests per Window | 50 | Sufficient for typical payment allocation workflows |
| Time Window | 60 seconds | Standard rate limiting window |
| Fallback IP | "unknown" | For requests with no identifiable IP |

## Usage

### In Express Routes

```typescript
import { partialPaymentAllocatorRateLimitMiddleware } from './middleware/partial-payment-allocator-rate-limit.js';

router.post(
  '/api/payments/allocate',
  partialPaymentAllocatorRateLimitMiddleware,
  allocatePaymentHandler
);
```

### Response Examples

**Successful Request (Under Limit)**
```json
HTTP/1.1 200 OK
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 49
X-RateLimit-Reset: 1695000000

{
  "success": true,
  "allocation": { ... }
}
```

**Rate Limit Exceeded**
```json
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1695000000

{
  "success": false,
  "error": "Too many requests, please try again later"
}
```

## Testing

### Test Coverage

The test suite (`__tests__/partial-payment-allocator-rate-limit.test.ts`) includes:

#### Basic Rate Limiting Tests
- ✅ Allow requests under the limit
- ✅ Reject requests exceeding limit with 429
- ✅ Return proper rate limit headers
- ✅ Correctly decrement remaining count

#### Multiple Client Isolation Tests
- ✅ Track separate buckets for different IPs
- ✅ Handle requests with socket.remoteAddress fallback
- ✅ Handle requests with no IP (unknown client)

#### Environment Configuration Tests
- ✅ Use custom window duration from environment
- ✅ Use custom max requests from environment
- ✅ Fall back to defaults for invalid values

#### Window Reset Tests
- ✅ Reset bucket after window expires
- ✅ Allow new requests after reset

#### Rate Limit Headers Tests
- ✅ Include all required rate limit headers
- ✅ Set reset time correctly

#### Response Format Tests
- ✅ Return correct 429 response format when limit exceeded

#### Reset Functionality Tests
- ✅ Clear all buckets when reset is called

#### Remaining Count Logic Tests
- ✅ Show 0 remaining when limit is reached
- ✅ Never show negative remaining count

### Running Tests

```bash
# Run all tests
npm test

# Run only partial payment allocator rate limit tests
npm test -- __tests__/partial-payment-allocator-rate-limit.test.ts

# Run with coverage
npm test -- --coverage
```

## Implementation Details

### Bucket Structure

```typescript
type RateBucket = {
  count: number;      // Current request count in window
  resetAt: number;    // Timestamp when window expires (milliseconds)
};
```

### Client Identification

```typescript
const key = req.ip || req.socket.remoteAddress || "unknown";
```

Priority:
1. Express `req.ip` (respects X-Forwarded-For, etc.)
2. Socket remote address
3. "unknown" fallback (all requests from unknown IPs share one bucket)

### Rate Limit Calculation

**Remaining Requests:**
```typescript
remaining = Math.max(0, maxRequests - currentCount)
```

The `Math.max(0, ...)` ensures remaining never goes negative.

**Window Reset Time:**
```typescript
resetTimestamp = currentTimeMs + windowMs
```

Reset time is the window expiry time, converted to Unix seconds for the header.

## Security Considerations

### DDoS Protection
- IP-based rate limiting helps mitigate Layer 7 (application-level) DDoS attacks
- Separate buckets per IP prevents one client from blocking others

### Bypass Prevention
- Requests without IP fall back to shared "unknown" bucket
- Prevents attackers from bypassing limits via anonymous requests

### Configuration Validation
- Environment variable parsing includes fallback to defaults
- Invalid values (negative, non-numeric) are rejected

### Memory Management
- Buckets are only created on first request from a client
- Expired buckets are recreated (not stored indefinitely)
- The `reset*` functions provide testing cleanup

## Performance Characteristics

### Time Complexity
- Per-request: O(1) - Map lookup and counter update
- Reset: O(n) - n = number of active clients

### Memory Usage
- Per client: ~40 bytes (two integers + object overhead)
- 1000 active clients ≈ 40KB
- No memory growth beyond active clients

### CPU Cost
- Minimal: single Map operation per request
- No database queries or external calls

## Best Practices

1. **Adjust Limits Based on Load**
   - Monitor 429 responses in production
   - Increase limit if legitimate users are affected
   - Decrease limit if under attack

2. **Coordinate with Other Middleware**
   - Apply rate limiting early in middleware chain
   - After CORS but before expensive operations

3. **Handle 429 on Client Side**
   - Implement exponential backoff
   - Use Retry-After header (can be added to implementation)
   - Inform users with friendly error messages

4. **Monitor and Alert**
   - Track 429 response rate
   - Alert on sustained high rates
   - Correlate with suspicious activity

## Future Enhancements

1. **Distributed Rate Limiting**
   - Share buckets across multiple servers using Redis
   - Supports load-balanced deployments

2. **Sliding Window Algorithm**
   - More precise rate limiting
   - Better fairness for clients near window boundaries

3. **Retry-After Header**
   - Include in 429 response
   - Helps clients implement smarter retry logic

4. **Rate Limit Tiers**
   - Different limits for authenticated vs anonymous
   - Premium tier with higher limits

5. **Metrics Export**
   - Prometheus/Grafana integration
   - Track rate limit hits per endpoint

## Troubleshooting

### 429 Responses from Legitimate Clients

**Symptoms**: Legitimate clients receive 429 "Too Many Requests"

**Causes**:
- Limit too low for actual traffic
- Client implementation sends bursts of requests
- Multiple clients share same IP (e.g., behind NAT)

**Solutions**:
- Increase `PARTIAL_PAYMENT_ALLOCATOR_RATE_MAX` environment variable
- Batch multiple payment allocations into fewer requests
- Implement client-side request queuing

### Rate Limit Not Working

**Symptoms**: All requests succeed even when exceeding limit

**Causes**:
- Middleware not applied to route
- Environment variables misconfigured
- Wrong middleware function used

**Solutions**:
- Verify middleware is in route definition
- Check environment variables with `console.log(process.env)`
- Import correct middleware (`partialPaymentAllocatorRateLimitMiddleware`)

### Memory Increasing Indefinitely

**Symptoms**: Node process memory grows over time

**Causes**:
- Buckets never reset (unlikely with current implementation)
- Other memory leaks unrelated to rate limiting

**Solutions**:
- Monitor with `process.memoryUsage()`
- Check bucket count in tests with reset function
- Profile with Node profiler tools

## Compliance

This implementation aligns with:
- RFC 6585: Rate Limit Headers
- IETF Draft: Rate Limit Header Fields
- Industry best practices for API rate limiting
