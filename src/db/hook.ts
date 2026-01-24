/**
 * Webhook receiver handler using Kysely
 * Handles POST /hook/:id requests with standard webhook validation
 */

import { Context } from "hono";
import { getDatabase, sql } from "./client.ts";
import { computeWebhookSignature, verifyWebhookSignature } from "../utils/webhook.ts";

// Request payload shape
type WebhookRequest = {
  headers: Record<string, string>;
  body: string;
};

// Result codes for webhook_receiver_logs.result column
enum WebhookResult {
  SUCCESS = 10,
  SIGNATURE_FAILED = 20,
  INVALID_JSON = 30,
  TABLE_NOT_FOUND = 40,
  INSERT_FAILED = 50,
}

export async function handleHook(c: Context) {
  const db = getDatabase();
  
  try {
    // Extract webhook_receiver_id from URL path
    const webhookReceiverId = parseInt(c.req.param('id'));
    if (isNaN(webhookReceiverId)) {
      return c.json({ error: 'Invalid webhook_receiver_id' }, 400);
    }

    // Parse and validate request
    const requestData = await c.req.json<WebhookRequest>();
    if (!requestData.headers || !requestData.body) {
      return c.json({ error: 'Missing required fields: headers and body' }, 400);
    }

    // Normalize headers to lowercase
    const headers: Record<string, string> = {};
    Object.keys(requestData.headers).forEach(key => {
      headers[key.toLowerCase()] = requestData.headers[key];
    });

    const webhookId = headers['webhook-id'];
    const webhookTimestampStr = headers['webhook-timestamp'] || Math.floor(Date.now() / 1000).toString();
    const webhookSignature = headers['webhook-signature'];
    const bodyStr = requestData.body;

    // Find webhook receiver configuration
    const receiver = await findWebhookReceiver(db, webhookReceiverId);
    if (!receiver) {
      return c.json({ error: 'Webhook receiver not found' }, 404);
    }

    // Validate signature if HMAC auth is enabled
    const signatureValidation = await validateSignature(
      receiver,
      webhookId,
      webhookTimestampStr,
      bodyStr,
      webhookSignature
    );

    if (!signatureValidation.valid) {
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        webhookId || 'unknown',
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        WebhookResult.SIGNATURE_FAILED,
        signatureValidation.error || 'Signature verification failed'
      );
      return c.json({ error: signatureValidation.error }, 401);
    }

    // Compute idempotency key
    const idempotencyKey = await computeIdempotencyKey(
      receiver,
      webhookId,
      webhookTimestampStr,
      bodyStr,
      webhookSignature,
      webhookReceiverId
    );

    // Check for duplicate
    if (await isDuplicateRequest(db, webhookReceiverId, idempotencyKey)) {
      return c.json({ success: true, message: 'Duplicate request ignored' }, 200);
    }

    // Parse webhook body
    let webhookData: any;
    try {
      webhookData = JSON.parse(bodyStr);
    } catch (e) {
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        WebhookResult.INVALID_JSON,
        'Invalid JSON in body'
      );
      return c.json({ error: 'Invalid JSON in body' }, 400);
    }

    // Get table and field metadata
    const tableMetadata = await getTableMetadata(db, receiver.table_name);
    if (!tableMetadata) {
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        WebhookResult.TABLE_NOT_FOUND,
        `Table metadata not found for ${receiver.table_name}`
      );
      return c.json({ error: `Table metadata not found for ${receiver.table_name}` }, 404);
    }

    const fieldNames = await getFieldNames(db, receiver.table_name);

    // Filter webhook data to only include defined fields
    const insertData = filterWebhookData(webhookData, fieldNames);

    // Execute insert or upsert
    try {
      await insertOrUpsertData(db, receiver.table_name, insertData, webhookData, tableMetadata.id_column);

      // Log success
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        WebhookResult.SUCCESS,
        null
      );

      return c.json({ success: true }, 200);
    } catch (error: any) {
      // Log failure
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        WebhookResult.INSERT_FAILED,
        error.message || 'Unknown error during insert/upsert'
      );

      return c.json({ error: 'Failed to insert/upsert data', details: error.message }, 500);
    }
  } catch (error: any) {
    console.error('Webhook handler error:', error);
    return c.json({ error: 'Internal server error', details: error.message }, 500);
  }
}

/**
 * Find webhook receiver configuration by ID
 */
async function findWebhookReceiver(db: any, webhookReceiverId: number) {
  const result = await sql`
    SELECT id, label, table_name, auth_type, secret
    FROM webhook_receivers
    WHERE id = ${webhookReceiverId}
  `.execute(db);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as {
    id: number;
    label: string;
    table_name: string;
    auth_type: string;
    secret: string | null;
  };
}

/**
 * Validate webhook signature for HMAC auth
 */
async function validateSignature(
  receiver: { auth_type: string; secret: string | null },
  webhookId: string | undefined,
  webhookTimestampStr: string,
  bodyStr: string,
  webhookSignature: string | undefined
): Promise<{ valid: boolean; error?: string }> {
  if (receiver.auth_type !== 'hmac') {
    return { valid: true };
  }

  if (!receiver.secret) {
    return { valid: false, error: 'HMAC secret not configured' };
  }

  if (!webhookId || !webhookSignature) {
    return { valid: false, error: 'Missing webhook-id or webhook-signature for HMAC validation' };
  }

  const isValid = await verifyWebhookSignature(
    webhookId,
    webhookTimestampStr,
    bodyStr,
    receiver.secret,
    webhookSignature
  );

  return isValid ? { valid: true } : { valid: false, error: 'Signature verification failed' };
}

/**
 * Compute idempotency key based on auth type and available data
 */
async function computeIdempotencyKey(
  receiver: { auth_type: string; secret: string | null },
  webhookId: string | undefined,
  webhookTimestampStr: string,
  bodyStr: string,
  webhookSignature: string | undefined,
  webhookReceiverId: number
): Promise<string> {
  // For HMAC, use webhook-id
  if (receiver.auth_type === 'hmac' && webhookId) {
    return webhookId;
  }

  // For non-HMAC with secret, compute signature for idempotency
  if (receiver.secret && webhookId) {
    return await computeWebhookSignature(webhookId, webhookTimestampStr, bodyStr, receiver.secret);
  }

  // Use signature if available
  if (webhookSignature) {
    return webhookSignature;
  }

  // Fallback: compute from content
  const idempotencySource = `${webhookReceiverId}-${webhookTimestampStr}-${bodyStr}`;
  return await computeWebhookSignature(
    webhookId || 'anon',
    webhookTimestampStr,
    bodyStr,
    receiver.secret || idempotencySource
  );
}

/**
 * Check if request is duplicate based on idempotency key
 */
async function isDuplicateRequest(db: any, webhookReceiverId: number, idempotencyKey: string): Promise<boolean> {
  const result = await sql`
    SELECT id FROM webhook_receiver_logs
    WHERE webhook_receiver_id = ${webhookReceiverId}
    AND webhook_id = ${idempotencyKey}
  `.execute(db);

  return result.rows.length > 0;
}

/**
 * Get table metadata
 */
async function getTableMetadata(db: any, tableName: string) {
  const result = await sql`
    SELECT table_name, id_column
    FROM tables
    WHERE table_name = ${tableName}
  `.execute(db);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as { table_name: string; id_column: string | null };
}

/**
 * Get field names for a table
 */
async function getFieldNames(db: any, tableName: string): Promise<Set<string>> {
  const result = await sql`
    SELECT field_name
    FROM fields
    WHERE table_name = ${tableName}
  `.execute(db);

  return new Set(result.rows.map((f: any) => f.field_name));
}

/**
 * Filter webhook data to only include fields defined in the table
 */
function filterWebhookData(webhookData: any, fieldNames: Set<string>): Record<string, any> {
  const insertData: Record<string, any> = {};
  for (const key in webhookData) {
    if (fieldNames.has(key)) {
      insertData[key] = webhookData[key];
    }
  }
  return insertData;
}

/**
 * Insert or upsert data into target table
 */
async function insertOrUpsertData(
  db: any,
  tableName: string,
  insertData: Record<string, any>,
  webhookData: any,
  idColumn: string | null
) {
  const hasIdValue = idColumn && webhookData[idColumn] !== undefined && webhookData[idColumn] !== null;
  const columns = Object.keys(insertData);
  const values = Object.values(insertData);

  if (hasIdValue && idColumn) {
    // Upsert: ON CONFLICT DO UPDATE
    const updateSet = columns.map(col => `${col} = EXCLUDED.${col}`).join(', ');
    await sql`
      INSERT INTO ${sql.table(tableName)} (${sql.join(columns.map(c => sql.id(c)))})
      VALUES (${sql.join(values.map(v => sql.lit(v)))})
      ON CONFLICT (${sql.id(idColumn)}) 
      DO UPDATE SET ${sql.raw(updateSet)}
    `.execute(db);
  } else {
    // Insert only
    await sql`
      INSERT INTO ${sql.table(tableName)} (${sql.join(columns.map(c => sql.id(c)))})
      VALUES (${sql.join(values.map(v => sql.lit(v)))})
    `.execute(db);
  }
}

/**
 * Log webhook attempt to webhook_receiver_logs
 */
async function logWebhookAttempt(
  db: any,
  webhookReceiverId: number,
  idempotencyKey: string,
  webhookTimestamp: number,
  payload: any,
  result: WebhookResult,
  errorMessage: string | null
) {
  try {
    await sql`
      INSERT INTO webhook_receiver_logs (
        webhook_receiver_id, webhook_id, webhook_timestamp, 
        received_timestamp, payload, result, error_message
      )
      VALUES (
        ${webhookReceiverId},
        ${idempotencyKey},
        ${new Date(webhookTimestamp * 1000)},
        ${new Date()},
        ${JSON.stringify(payload)},
        ${result},
        ${errorMessage}
      )
    `.execute(db);
  } catch (error) {
    console.error('Failed to log webhook attempt:', error);
  }
}

