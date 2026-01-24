# Webhook Receiver Implementation

This implementation provides a webhook receiver endpoint that validates, processes, and logs incoming webhook requests.

## Features

- **Standard Webhook Signature Validation**: Supports HMAC-SHA256 signature verification using the standard webhook format: `webhook-id.webhook-timestamp.body`
- **Idempotency**: Prevents duplicate processing of webhooks using idempotency keys
- **Dynamic Data Insertion**: Automatically maps webhook payload to database tables based on field metadata
- **Upsert Support**: Updates existing records or inserts new ones based on primary key presence
- **Comprehensive Logging**: Logs all webhook attempts with detailed error messages
- **Flexible Authentication**: Supports both HMAC authentication and no authentication (none)

## API Endpoint

### POST /hook/:id

Receives webhook data and processes it according to the webhook receiver configuration.

**Path Parameters:**
- `id` - The webhook receiver ID

**Request Body:**
```json
{
  "headers": {
    "webhook-id": "msg_unique_id",
    "webhook-timestamp": "1769024741",
    "webhook-signature": "v1,base64_signature"
  },
  "body": "{\"field1\":\"value1\",\"field2\":\"value2\"}"
}
```

**Response (Success):**
```json
{
  "success": true
}
```

**Response (Duplicate):**
```json
{
  "success": true,
  "message": "Duplicate request ignored"
}
```

**Response (Error):**
```json
{
  "error": "Error description",
  "details": "Additional error details (optional)"
}
```

## Database Schema

### webhook_receivers

Stores webhook receiver configurations:

| Column | Type | Description |
|--------|------|-------------|
| id | int4 | Primary key |
| label | text | Receiver name/description |
| table_name | text | Target table for data insertion |
| auth_type | text | Authentication type: 'hmac' or 'none' |
| secret | text | HMAC secret key (required for auth_type='hmac') |

### webhook_receiver_logs

Logs all webhook attempts:

| Column | Type | Description |
|--------|------|-------------|
| id | int4 | Primary key |
| webhook_receiver_id | int4 | Foreign key to webhook_receivers |
| webhook_id | text | Idempotency key (from webhook-id or computed) |
| webhook_timestamp | timestamp | Timestamp from webhook headers |
| received_timestamp | timestamp | Server timestamp when received |
| payload | jsonb | Full webhook payload |
| result | int4 | Result code (10=success, 20=sig fail, etc.) |
| error_message | text | Error details if failed |

### tables

Metadata about target tables:

| Column | Type | Description |
|--------|------|-------------|
| table_name | text | Name of the table |
| id_column | text | Primary key column name |

### fields

Metadata about table fields:

| Column | Type | Description |
|--------|------|-------------|
| table_name | text | Table name |
| field_name | text | Column name |
| format | text | Data type |
| is_pk | bool | Is primary key |
| is_nullable | bool | Can be null |

## Processing Flow

1. **Parse Request**: Extract webhook_receiver_id from URL and validate request body
2. **Find Receiver**: Look up webhook receiver configuration
3. **Verify Signature**: If auth_type='hmac', verify webhook signature
4. **Compute Idempotency Key**: 
   - For HMAC: use webhook-id
   - For none: compute signature using webhook-id, timestamp, and body
   - If no webhook-id: use webhook-signature or compute a default
5. **Check for Duplicates**: Query webhook_receiver_logs for existing idempotency_key
6. **Parse Webhook Data**: Parse JSON body
7. **Get Table Metadata**: Retrieve table and field definitions
8. **Build Insert/Upsert**: Filter webhook data to match table fields
9. **Execute**: Insert or upsert data into target table
10. **Log Result**: Record attempt in webhook_receiver_logs

## Signature Verification

For webhooks with `auth_type='hmac'`, the signature is verified using:

```
message = webhook-id + "." + webhook-timestamp + "." + body
signature = "v1," + base64(HMAC-SHA256(message, secret))
```

The computed signature must match the `webhook-signature` header exactly.

## Idempotency

To prevent duplicate processing:

1. **HMAC authenticated webhooks**: Use `webhook-id` as idempotency key
2. **Non-authenticated webhooks**: Compute a signature from the webhook data as idempotency key
3. Before processing, check if an entry exists in `webhook_receiver_logs` with the same `webhook_receiver_id` and `webhook_id` (idempotency key)
4. If found, return success without reprocessing

This ensures that even replayed or retried webhooks are only processed once.

## Error Codes

Result codes in `webhook_receiver_logs`:

- **10**: Success
- **20**: Signature verification failed
- **30**: Invalid JSON in body
- **40**: Table metadata not found
- **50**: Insert/upsert failed (database error)

## Environment Variables

Required environment variables:

- `SUPABASE_URL` or `API_BASE_URL`: PostgREST API endpoint
- `API_KEY` or `SUPABASE_ANON_KEY`: API authentication key

## Usage Example

### 1. Create a webhook receiver

```sql
INSERT INTO webhook_receivers (label, table_name, auth_type, secret)
VALUES ('Customer Webhook', 'customers', 'hmac', 'your_secret_key_here');
```

### 2. Define table metadata

```sql
INSERT INTO tables (table_name, id_column)
VALUES ('customers', 'id');

INSERT INTO fields (table_name, field_name, format, is_pk, is_nullable)
VALUES 
  ('customers', 'id', 'int32', true, false),
  ('customers', 'name', 'text', false, false),
  ('customers', 'email', 'email', false, false);
```

### 3. Send webhook request

```bash
curl -X POST https://your-api.com/hook/1 \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "webhook-id": "msg_abc123",
      "webhook-timestamp": "1769024741",
      "webhook-signature": "v1,computed_signature"
    },
    "body": "{\"name\":\"John Doe\",\"email\":\"john@example.com\"}"
  }'
```

## Security Considerations

1. **Use HTTPS**: Always use HTTPS in production to protect webhook data
2. **Rotate Secrets**: Regularly rotate HMAC secrets
3. **Validate Timestamps**: Consider implementing timestamp validation to prevent replay attacks
4. **Rate Limiting**: Implement rate limiting to prevent abuse
5. **Input Validation**: The handler filters fields based on metadata, but additional validation may be needed
6. **Monitor Logs**: Regularly review webhook_receiver_logs for suspicious activity

## Testing

See [../tests/TESTING.md](../tests/TESTING.md) for comprehensive test scenarios and validation procedures.

## Implementation Details

- **Web Crypto API**: Uses standard Web Crypto API for HMAC computation (compatible with Deno, Node 18+, and browsers)
- **PostgREST Integration**: Uses existing PostgREST utility for database operations
- **Error Handling**: All errors are logged with appropriate error codes
- **Async Processing**: All operations are asynchronous for better performance

## Future Enhancements

Potential improvements:

1. Timestamp validation with configurable tolerance
2. Webhook retry logic
3. Webhook transformation using JSONata (as indicated by jsonata field in webhook_receivers)
4. Batch webhook processing
5. Webhook event filtering
6. Custom validation rules per receiver
7. Webhook forwarding/chaining
