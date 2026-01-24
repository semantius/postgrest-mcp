/**
 * Webhook receiver handler
 * Handles POST /hook/:id requests
 */

import { Context } from 'hono';
import { makePostgrestRequest } from '../utils/postgrest.ts';
import { computeWebhookSignature, verifyWebhookSignature } from '../utils/webhook.ts';

interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
}

interface WebhookReceiver {
  id: number;
  label: string;
  table_name: string;
  auth_type: string;
  secret: string | null;
}

interface TableMetadata {
  table_name: string;
  id_column: string | null;
}

interface FieldMetadata {
  field_name: string;
  format: string;
  is_pk: boolean;
  is_nullable: boolean;
}

export async function handleWebhook(c: Context) {
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
    const receiverResponse = await makePostgrestRequest({
      path: `/webhook_receivers?id=eq.${webhookReceiverId}`,
      method: 'GET',
    });

    if (!receiverResponse.response.data || receiverResponse.response.data.length === 0) {
      return c.json({ error: 'Webhook receiver not found' }, 404);
    }

    const receiver: WebhookReceiver = receiverResponse.response.data[0];

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
    // This ensures idempotency even for webhooks without authentication
    if (!idempotencyKey) {
      // Generate a hash from webhook data for idempotency
      // Use a combination that's unique to this specific webhook
      const idempotencySource = `${webhookReceiverId}-${webhookTimestampStr}-${bodyStr}`;
      idempotencyKey = await computeWebhookSignature(
        webhookId || 'anon',
        webhookTimestampStr,
        bodyStr,
        receiver.secret || idempotencySource // Use content itself as secret if none available
      );
    }

    // Step 3: Check for duplicate using idempotency_key
    const duplicateCheck = await makePostgrestRequest({
      path: `/webhook_receiver_logs?webhook_receiver_id=eq.${webhookReceiverId}&webhook_id=eq.${encodeURIComponent(idempotencyKey)}`,
      method: 'GET',
    });

    if (duplicateCheck.response.data && duplicateCheck.response.data.length > 0) {
      // Duplicate request, return success without processing
      return c.json({ success: true, message: 'Duplicate request ignored' }, 200);
    }

    // Step 4: Parse webhook body
    let webhookData: any;
    try {
      webhookData = JSON.parse(bodyStr);
    } catch (e) {
      await logWebhookAttempt(
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
    const tableResponse = await makePostgrestRequest({
      path: `/tables?table_name=eq.${receiver.table_name}`,
      method: 'GET',
    });

    if (!tableResponse.response.data || tableResponse.response.data.length === 0) {
      await logWebhookAttempt(
        webhookReceiverId,
        idempotencyKey,
        parseInt(webhookTimestampStr),
        { headers, body: bodyStr },
        40,
        `Table metadata not found for ${receiver.table_name}`
      );
      return c.json({ error: `Table metadata not found for ${receiver.table_name}` }, 404);
    }

    const tableMetadata: TableMetadata = tableResponse.response.data[0];

    // Step 6: Get field definitions
    const fieldsResponse = await makePostgrestRequest({
      path: `/fields?table_name=eq.${receiver.table_name}`,
      method: 'GET',
    });

    const fields: FieldMetadata[] = fieldsResponse.response.data || [];
    const fieldNames = new Set(fields.map(f => f.field_name));

    // Step 7: Build insert/upsert data
    const insertData: Record<string, any> = {};
    for (const key in webhookData) {
      if (fieldNames.has(key)) {
        insertData[key] = webhookData[key];
      }
    }

    // Step 8: Execute insert or upsert
    try {
      const idColumn = tableMetadata.id_column;
      // Check if ID field exists and has a non-null value (0, empty string, etc. are valid IDs)
      const hasIdValue = idColumn && webhookData[idColumn] !== undefined && webhookData[idColumn] !== null;

      if (hasIdValue) {
        // Upsert: update if exists, insert if not
        await makePostgrestRequest({
          path: `/${receiver.table_name}`,
          method: 'POST',
          body: insertData,
          additionalHeaders: {
            'Prefer': 'resolution=merge-duplicates',
          },
        });
      } else {
        // Insert only
        await makePostgrestRequest({
          path: `/${receiver.table_name}`,
          method: 'POST',
          body: insertData,
        });
      }

      // Log success
      await logWebhookAttempt(
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
  webhookReceiverId: number,
  idempotencyKey: string,
  webhookTimestamp: number,
  payload: any,
  result: number,
  errorMessage: string | null
) {
  try {
    await makePostgrestRequest({
      path: '/webhook_receiver_logs',
      method: 'POST',
      body: {
        webhook_receiver_id: webhookReceiverId,
        webhook_id: idempotencyKey, // webhook_id field stores the idempotency key
        webhook_timestamp: new Date(webhookTimestamp * 1000).toISOString(),
        payload: payload,
        result: result,
        error_message: errorMessage,
      },
    });
  } catch (error) {
    console.error('Failed to log webhook attempt:', error);
  }
}
