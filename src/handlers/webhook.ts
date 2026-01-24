/**
 * Webhook receiver handler using Kysely for direct database access
 * Bypasses RLS policies to insert webhook data directly
 */

import { Context } from 'hono';
import { sql as rawSql } from 'kysely';
import { createDb, type Database } from '../utils/db.ts';
import { computeWebhookSignature, verifyWebhookSignature } from '../utils/webhook.ts';
import type { Kysely } from 'kysely';

// Request payload shape
type WebhookRequest = {
  headers: Record<string, string>;
  body: string;
};

export async function handleWebhook(c: Context) {
  const db = createDb();
  
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

    // Step 1: Find webhook_receivers record using Kysely
    const receiver = await db
      .selectFrom('webhook_receivers')
      .selectAll()
      .where('id', '=', webhookReceiverId)
      .executeTakeFirst();

    if (!receiver) {
      return c.json({ error: 'Webhook receiver not found' }, 404);
    }

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
          webhookId, // For HMAC, webhook-id is the idempotency key
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
        receiver.secret || idempotencySource // Use content itself as secret if none available
      );
    }

    // Step 3: Check for duplicate using idempotency_key with Kysely
    const existingLog = await db
      .selectFrom('webhook_receiver_logs')
      .selectAll()
      .where('webhook_receiver_id', '=', webhookReceiverId)
      .where('webhook_id', '=', idempotencyKey)
      .executeTakeFirst();

    if (existingLog) {
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

    // Step 5: Get table metadata using Kysely
    const tableMetadata = await db
      .selectFrom('tables')
      .selectAll()
      .where('table_name', '=', receiver.table_name)
      .executeTakeFirst();

    if (!tableMetadata) {
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

    // Step 6: Get field definitions using Kysely
    const fields = await db
      .selectFrom('fields')
      .selectAll()
      .where('table_name', '=', receiver.table_name)
      .execute();

    const fieldNames = new Set(fields.map(f => f.field_name));

    // Step 7: Build insert/upsert data
    const insertData: Record<string, any> = {};
    for (const key in webhookData) {
      if (fieldNames.has(key)) {
        insertData[key] = webhookData[key];
      }
    }

    // Step 8: Execute insert or upsert using Kysely with raw SQL
    try {
      const idColumn = tableMetadata.id_column;
      // Check if ID field exists and has a non-null value
      const hasIdValue = idColumn && webhookData[idColumn] !== undefined && webhookData[idColumn] !== null;

      if (hasIdValue) {
        // Upsert: ON CONFLICT DO UPDATE
        const columns = Object.keys(insertData);
        const values = Object.values(insertData);
        
        await rawSql`
          INSERT INTO ${rawSql.table(receiver.table_name)} (${rawSql.join(columns.map(c => rawSql.id(c)))})
          VALUES (${rawSql.join(values.map(v => rawSql.lit(v)))})
          ON CONFLICT (${rawSql.id(idColumn)}) 
          DO UPDATE SET ${rawSql.join(columns.map(c => rawSql`${rawSql.id(c)} = EXCLUDED.${rawSql.id(c)}`))}
        `.execute(db);
      } else {
        // Insert only
        await rawSql`
          INSERT INTO ${rawSql.table(receiver.table_name)} (${rawSql.join(Object.keys(insertData).map(c => rawSql.id(c)))})
          VALUES (${rawSql.join(Object.values(insertData).map(v => rawSql.lit(v)))})
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
  } finally {
    await db.destroy();
  }
}

/**
 * Log webhook attempt to webhook_receiver_logs using Kysely
 */
async function logWebhookAttempt(
  db: Kysely<Database>,
  webhookReceiverId: number,
  idempotencyKey: string,
  webhookTimestamp: number,
  payload: any,
  result: number,
  errorMessage: string | null
) {
  try {
    await db
      .insertInto('webhook_receiver_logs')
      .values({
        webhook_receiver_id: webhookReceiverId,
        webhook_id: idempotencyKey, // webhook_id field stores the idempotency key
        webhook_timestamp: new Date(webhookTimestamp * 1000),
        received_timestamp: new Date(),
        payload: JSON.stringify(payload),
        result: result,
        error_message: errorMessage,
        label: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  } catch (error) {
    console.error('Failed to log webhook attempt:', error);
  }
}
