/**
 * Webhook signature validation utilities
 */

/**
 * Normalize webhook secret by decoding whsec_ prefix
 * If secret starts with whsec_, base64 decode the part after the prefix
 * Otherwise, use the secret as-is
 */
function normalizeSecret(secret: string): string {
  if (secret.startsWith('whsec_')) {
    // Remove whsec_ prefix and base64 decode
    const base64Part = secret.slice(6); // Remove 'whsec_' prefix
    const binaryString = atob(base64Part);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  }
  
  // Use secret as-is if no whsec_ prefix
  return secret;
}

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
  
  // Normalize secret
  const normalizedSecret = normalizeSecret(secret);
  
  // Encode secret and message as Uint8Array
  const encoder = new TextEncoder();
  const keyData = encoder.encode(normalizedSecret);
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
  
  // Convert to base64 efficiently (avoiding spread operator for large arrays)
  const signatureArray = new Uint8Array(signature);
  const binaryString = Array.from(signatureArray, byte => String.fromCharCode(byte)).join('');
  const base64Signature = btoa(binaryString);
  
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
