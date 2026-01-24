/**
 * Webhook signature validation utilities
 */

/**
 * Compute standard webhook signature using Web Crypto API
 * Format: webhook-id.webhook-timestamp.body
 */
export async function computeWebhookSignature(
  webhookId: string,
  webhookTimestamp: string,
  body: string,
  secret: string
): Promise<string> {
  const message = `${webhookId}.${webhookTimestamp}.${body}`;
  
  // Encode secret and message as Uint8Array
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);
  
  // Import key for HMAC
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  // Sign the message
  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  
  // Convert to base64
  const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `v1,${base64Signature}`;
}

/**
 * Verify webhook signature
 */
export async function verifyWebhookSignature(
  webhookId: string,
  webhookTimestamp: string,
  body: string,
  secret: string,
  providedSignature: string
): Promise<boolean> {
  const computedSignature = await computeWebhookSignature(webhookId, webhookTimestamp, body, secret);
  return computedSignature === providedSignature;
}
