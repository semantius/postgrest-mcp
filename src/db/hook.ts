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

export async function handleHook(c: Context) {
  const db = getDatabase();
  
  try {
    // Extract webhook_receiver_id from URL path
    const webhookReceiverId = parseInt(c.req.param('id'));
    if (isNaN(webhookReceiverId)) {
      return c.json({ error: 'Invalid webhook_receiver_id' }, 400);
    }

    // Parse request body
    const requestData = await c.req.json<WebhookRequest>();
    
    if (!requestData.headers || !requestData.body) {
      return c.json({ error: 'Missing required fields: headers and body' }, 400);
    }

    // Extract headers (case-insensitive)
    const headers: Record<string, string> = {};
    Object.keys(requestData.headers).forEach(key => {
      headers[key.toLowerCase()] = requestData.headers[key];
    });

    const webhookId = headers['webhook-id'];
    // Use current timestamp if not provided (in seconds since epoch)
    const webhookTimestampStr = headers['webhook-timestamp'] || Math.floor(Date.now() / 1000).toString();
    const webhookSignature = headers['webhook-signature'];
    const bodyStr = requestData.body;

    // Use webhook-id as idempotency_key, will be replaced later if needed
    let idempotencyKey = webhookId || '';

    // Step 1: Find webhook_receivers record
    const receiverResult = await sql`
      SELECT id, label, table_name, auth_type, secret
      FROM webhook_receivers
      WHERE id = ${webhookReceiverId}
    `.execute(db);

    if (receiverResult.rows.length === 0) {
      return c.json({ error: 'Webhook receiver not found' }, 404);
    }

    const receiver = receiverResult.rows[0] as {
      id: number;
      label: string;
      table_name: string;
      auth_type: string;
      secret: string | null;
    };

    // Step 2: Compute and verify webhook signature
    if (receiver.auth_type === 'hmac') {
      if (!receiver.secret) {
        return c.json({ error: 'HMAC secret not configured' }, 500);
      }

      if (!webhookId || !webhookSignature) {
        return c.json({ error: 'Missing webhook-id or webhook-signature for HMAC validation' }, 400);
      }

      const isValid = await verifyWebhookSignature(
        webhookId,
        webhookTimestampStr,
        bodyStr,
        receiver.secret,
        webhookSignature
      );

      if (!isValid) {
        // Log failed attempt - use webhook-id as idempotency key for HMAC webhooks
        await logWebhookAttempt(
          db,
          webhookReceiverId,
          webhookId,
          parseInt(webhookTimestampStr),
          { headers, body: bodyStr },
          20, // result code for signature mismatch
          'Signature verification failed'
        );
        return c.json({ error: 'Signature verification failed' }, 401);
      }
    } else {
      // For auth_type=none, compute signature for idempotency
      if (receiver.secret && webhookId) {
        const computedSig = await computeWebhookSignature(
          webhookId,
          webhookTimestampStr,
          bodyStr,
          receiver.secret
        );
        idempotencyKey = computedSig;
      }
    }

    // Use signature as idempotency_key if idempotency_key is empty
    if (!idempotencyKey && webhookSignature) {
      idempotencyKey = webhookSignature;
    }

    // If still no idempotency_key, compute one based on webhook content
    if (!idempotencyKey) {
      // Generate a hash from webhook data for idempotency
      const idempotencySource = `${webhookReceiverId}-${webhookTimestampStr}-${bodyStr}`;
      idempotencyKey = await computeWebhookSignature(
        webhookId || 'anon',
        webhookTimestampStr,
        bodyStr,
        receiver.secret || idempotencySource
      );
    }

    // Step 3: Check for duplicate using idempotency_key
    const duplicateResult = await sql`
      SELECT id FROM webhook_receiver_logs
      WHERE webhook_receiver_id = ${webhookReceiverId}
      AND webhook_id = ${idempotencyKey}
    `.execute(db);

    if (duplicateResult.rows.length > 0) {
      // Duplicate request, return success without processing
      return c.json({ success: true, message: 'Duplicate request ignored' }, 200);
    }

    // Step 4: Parse webhook body
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
        30,
        'Invalid JSON in body'
      );
      return c.json({ error: 'Invalid JSON in body' }, 400);
    }

    // Step 5: Get table metadata
    const tableResult = await sql`
      SELECT table_name, id_column
      FROM tables
      WHERE table_name = ${receiver.table_name}
    `.execute(db);

    if (tableResult.rows.length === 0) {
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        40,
        `Table metadata not found for ${receiver.table_name}`
      );
      return c.json({ error: `Table metadata not found for ${receiver.table_name}` }, 404);
    }

    const tableMetadata = tableResult.rows[0] as { table_name: string; id_column: string | null };

    // Step 6: Get field definitions
    const fieldsResult = await sql`
      SELECT field_name, format, is_pk, is_nullable
      FROM fields
      WHERE table_name = ${receiver.table_name}
    `.execute(db);

    const fieldNames = new Set(fieldsResult.rows.map((f: any) => f.field_name));

    // Step 7: Build insert/upsert data - only include fields that exist in the table
    const insertData: Record<string, any> = {};
    for (const key in webhookData) {
      if (fieldNames.has(key)) {
        insertData[key] = webhookData[key];
      }
    }

    // Step 8: Execute insert or upsert using raw SQL
    try {
      const idColumn = tableMetadata.id_column;
      // Check if ID field exists and has a non-null value
      const hasIdValue = idColumn && webhookData[idColumn] !== undefined && webhookData[idColumn] !== null;

      const columns = Object.keys(insertData);
      const values = Object.values(insertData);

      if (hasIdValue && idColumn) {
        // Upsert: ON CONFLICT DO UPDATE
        const updateSet = columns.map(col => `${col} = EXCLUDED.${col}`).join(', ');
        await sql`
          INSERT INTO ${sql.table(receiver.table_name)} (${sql.join(columns.map(c => sql.id(c)))})
          VALUES (${sql.join(values.map(v => sql.lit(v)))})
          ON CONFLICT (${sql.id(idColumn)}) 
          DO UPDATE SET ${sql.raw(updateSet)}
        `.execute(db);
      } else {
        // Insert only
        await sql`
          INSERT INTO ${sql.table(receiver.table_name)} (${sql.join(columns.map(c => sql.id(c)))})
          VALUES (${sql.join(values.map(v => sql.lit(v)))})
        `.execute(db);
      }

      // Log success
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        10, // success code
        null
      );

      return c.json({ success: true }, 200);
    } catch (error: any) {
      // Log failure
      const errorMessage = error.message || 'Unknown error during insert/upsert';
      await logWebhookAttempt(
        db,
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        50, // insert/upsert failure code
        errorMessage
      );

      return c.json({ error: 'Failed to insert/upsert data', details: errorMessage }, 500);
    }
  } catch (error: any) {
    console.error('Webhook handler error:', error);
    return c.json({ error: 'Internal server error', details: error.message }, 500);
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
  result: number,
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

