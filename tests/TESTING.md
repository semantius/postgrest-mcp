# Webhook Receiver Testing Guide

This document describes the comprehensive test scenarios for the webhook receiver implementation.

## Setup Requirements

- A running PostgreSQL database with the following tables:
  - `webhook_receivers`
  - `webhook_receiver_logs`
  - `tables`
  - `fields`
  - At least one test table (e.g., `customers`)
- Direct database connection via DATABASE_URL environment variable
- Kysely bypasses RLS policies using service role credentials

## Test Data Setup

### 1. Create test webhook_receiver records

```sql
-- Test receiver with HMAC authentication
INSERT INTO webhook_receivers (id, label, table_name, auth_type, secret)
VALUES (123, 'Test Receiver HMAC', 'customers', 'hmac', 'test_secret_key');

-- Test receiver without authentication
INSERT INTO webhook_receivers (id, label, table_name, auth_type, secret)
VALUES (124, 'Test Receiver None', 'customers', 'none', NULL);

-- Test receiver with non-existent table
INSERT INTO webhook_receivers (id, label, table_name, auth_type, secret)
VALUES (125, 'Test Receiver Invalid', 'nonexistent_table', 'hmac', 'test_secret');
```

### 2. Create test table metadata

```sql
INSERT INTO tables (table_name, id_column)
VALUES ('customers', 'id');
```

### 3. Create test field definitions

```sql
INSERT INTO fields (table_name, field_name, format, is_pk, is_nullable)
VALUES 
  ('customers', 'id', 'int32', true, false),
  ('customers', 'customer_name', 'text', false, false),
  ('customers', 'email', 'email', false, false),
  ('customers', 'status', 'text', false, true);
```

## Test Scenarios

### Test 1: Invalid Request Data - Missing Required Fields

**Description:** Test that the handler rejects requests missing required fields.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected Response:** 400 Bad Request
```json
{
  "error": "Missing required fields: headers and body"
}
```

**Validation:** Verify no log entry is created in webhook_receiver_logs

---

### Test 2: webhook_receiver_id Not Matching a Record

**Description:** Test that the handler returns an error for non-existent webhook receiver.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/99999 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test001",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,xxx"
    },
    "body": "{\"event_type\":\"test\"}"
  }'
```

**Expected Response:** 404 Not Found
```json
{
  "error": "Webhook receiver not found"
}
```

**Validation:** Verify no log entry is created in webhook_receiver_logs

---

### Test 3: Signature Not Matching (HMAC)

**Description:** Test that the handler rejects requests with invalid HMAC signature.

**Generate invalid signature:**
```bash
# The signature should be computed as: webhook-id.webhook-timestamp.body
# For this test, we use an intentionally wrong signature
```

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test002",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,invalid_signature_here"
    },
    "body": "{\"event_type\":\"ping\",\"data\":{\"success\":true}}"
  }'
```

**Expected Response:** 401 Unauthorized
```json
{
  "error": "Signature verification failed"
}
```

**Validation:**
- Verify a log entry is created in webhook_receiver_logs with:
  - webhook_receiver_id = 123
  - webhook_id = "msg_test002"
  - result = 20
  - error_message = "Signature verification failed"

---

### Test 4: Valid Request with HMAC (Success)

**Description:** Test successful webhook processing with valid HMAC signature.

**Generate valid signature using the utility:**
```javascript
// Using the computeWebhookSignature function:
// webhookId: "msg_test003"
// timestamp: "1769024741"
// body: '{"customer_name":"John Doe","email":"john@example.com","status":"active"}'
// secret: "test_secret_key"
// Result: v1,<base64_signature>
```

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test003",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<computed_signature>"
    },
    "body": "{\"customer_name\":\"John Doe\",\"email\":\"john@example.com\",\"status\":\"active\"}"
  }'
```

**Expected Response:** 200 OK
```json
{
  "success": true
}
```

**Validation:**
- Verify a new customer record is created in the customers table
- Verify a log entry is created in webhook_receiver_logs with:
  - webhook_receiver_id = 123
  - webhook_id = "msg_test003"
  - result = 10
  - error_message = NULL

---

### Test 5: Payload Data Type Mismatch

**Description:** Test that the handler logs errors when data types don't match field definitions.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test004",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<computed_signature_for_this_body>"
    },
    "body": "{\"id\":\"not_a_number\",\"customer_name\":\"Jane Doe\"}"
  }'
```

**Expected Response:** 500 Internal Server Error (if database rejects the data)

**Validation:**
- Verify a log entry is created in webhook_receiver_logs with:
  - result = 50
  - error_message contains information about the type mismatch

---

### Test 6: Missing Required Payload Data

**Description:** Test handling of missing required fields in webhook payload.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test005",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<computed_signature>"
    },
    "body": "{\"email\":\"missing@example.com\"}"
  }'
```

**Expected Response:** 500 Internal Server Error (if customer_name is required)

**Validation:**
- Verify a log entry is created with result = 50
- Verify error_message mentions the missing required field

---

### Test 7: Duplicate Requests (Idempotency)

**Description:** Test that duplicate requests with the same idempotency_key are ignored.

**Setup:** First make a successful request (Test 4)

**Request:** Repeat Test 4 with the same webhook-id
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test003",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<same_signature_as_test4>"
    },
    "body": "{\"customer_name\":\"John Doe\",\"email\":\"john@example.com\",\"status\":\"active\"}"
  }'
```

**Expected Response:** 200 OK
```json
{
  "success": true,
  "message": "Duplicate request ignored"
}
```

**Validation:**
- Verify NO new customer record is created
- Verify NO new log entry is created in webhook_receiver_logs
- Verify the webhook_receiver_logs table still has only ONE entry for msg_test003

---

### Test 8: Auth Type None - Still Processes

**Description:** Test that webhooks with auth_type=none are still processed.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/124 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test006",
      "webhook-timestamp": "1769024741"
    },
    "body": "{\"customer_name\":\"Alice Smith\",\"email\":\"alice@example.com\"}"
  }'
```

**Expected Response:** 200 OK
```json
{
  "success": true
}
```

**Validation:**
- Verify a new customer record is created
- Verify a log entry is created with result = 10

---

### Test 9: Auth Type None - Idempotency Check

**Description:** Test that even with auth_type=none, duplicate requests are rejected.

**Setup:** First make a successful request (Test 8)

**Request:** Repeat Test 8 with the same data
```bash
curl -X POST http://localhost:3000/hook/124 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test006",
      "webhook-timestamp": "1769024741"
    },
    "body": "{\"customer_name\":\"Alice Smith\",\"email\":\"alice@example.com\"}"
  }'
```

**Expected Response:** 200 OK
```json
{
  "success": true,
  "message": "Duplicate request ignored"
}
```

**Validation:**
- Verify NO new customer record is created
- Verify only ONE log entry exists for this idempotency_key

---

### Test 10: Upsert Behavior

**Description:** Test that webhooks with existing ID perform upsert.

**Setup:** Create a customer record with id=100

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test007",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<computed_signature>"
    },
    "body": "{\"id\":100,\"customer_name\":\"Updated Name\",\"email\":\"updated@example.com\"}"
  }'
```

**Expected Response:** 200 OK

**Validation:**
- Verify the existing customer record is updated (not a new record created)
- Verify customer_name and email are updated

---

### Test 11: Invalid JSON in Body

**Description:** Test handling of malformed JSON in webhook body.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/123 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test008",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<computed_signature>"
    },
    "body": "{invalid json here}"
  }'
```

**Expected Response:** 400 Bad Request
```json
{
  "error": "Invalid JSON in body"
}
```

**Validation:**
- Verify a log entry is created with result = 30
- Verify error_message = "Invalid JSON in body"

---

### Test 12: Missing Timestamp (Default Behavior)

**Description:** Test that missing webhook-timestamp uses current timestamp.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/124 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test009"
    },
    "body": "{\"customer_name\":\"Bob Johnson\",\"email\":\"bob@example.com\"}"
  }'
```

**Expected Response:** 200 OK

**Validation:**
- Verify webhook_timestamp in the log entry is approximately the current time (within a few seconds)

---

### Test 13: Table Metadata Not Found

**Description:** Test error handling when table metadata is missing.

**Request:**
```bash
curl -X POST http://localhost:3000/hook/125 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_test010",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,<computed_signature>"
    },
    "body": "{\"test\":\"data\"}"
  }'
```

**Expected Response:** 404 Not Found
```json
{
  "error": "Table metadata not found for nonexistent_table"
}
```

**Validation:**
- Verify a log entry is created with result = 40

---

## Result Codes

The following result codes are used in webhook_receiver_logs:

- **10**: Success - Insert/upsert completed successfully
- **20**: Signature verification failed
- **30**: Invalid JSON in body
- **40**: Table metadata not found
- **50**: Insert/upsert failed (database error)

## Running Tests

### Manual Testing
Follow each test scenario above using curl commands.

### Automated Testing (Future)
To create an automated test suite, you would need:
1. A test database with the schema
2. A test harness that can:
   - Set up test data
   - Make HTTP requests
   - Verify database state
   - Clean up test data

Example test frameworks that could be used:
- Deno Test with database mocking
- Jest with supertest for HTTP testing
- Playwright for integration testing

## Security Considerations

When testing in production:
1. Use separate webhook receivers for testing
2. Use test tables that don't affect production data
3. Monitor webhook_receiver_logs for unexpected entries
4. Rotate secrets after testing
5. Clean up test data promptly
