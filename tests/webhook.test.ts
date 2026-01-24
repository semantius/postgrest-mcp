/**
 * Tests for webhook receiver handler
 * Run with: deno test --allow-net --allow-env
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeWebhookSignature, verifyWebhookSignature } from "../src/utils/webhook.ts";

// Use a realistic timestamp (January 1, 2024)
const TEST_TIMESTAMP = "1704067200";

// Test webhook signature utilities
Deno.test("computeWebhookSignature should generate valid signature", async () => {
  const webhookId = "msg_test123";
  const timestamp = TEST_TIMESTAMP;
  const body = '{"event_type":"ping","data":{"success":true}}';
  const secret = "test_secret_key";

  const signature = await computeWebhookSignature(webhookId, timestamp, body, secret);
  
  assertExists(signature);
  assertEquals(signature.startsWith("v1,"), true);
});

Deno.test("verifyWebhookSignature should validate correct signature", async () => {
  const webhookId = "msg_test123";
  const timestamp = TEST_TIMESTAMP;
  const body = '{"event_type":"ping","data":{"success":true}}';
  const secret = "test_secret_key";

  const signature = await computeWebhookSignature(webhookId, timestamp, body, secret);
  const isValid = await verifyWebhookSignature(webhookId, timestamp, body, secret, signature);
  
  assertEquals(isValid, true);
});

Deno.test("verifyWebhookSignature should reject invalid signature", async () => {
  const webhookId = "msg_test123";
  const timestamp = TEST_TIMESTAMP;
  const body = '{"event_type":"ping","data":{"success":true}}';
  const secret = "test_secret_key";

  const invalidSignature = "v1,invalid_signature_here";
  const isValid = await verifyWebhookSignature(webhookId, timestamp, body, secret, invalidSignature);
  
  assertEquals(isValid, false);
});

Deno.test("verifyWebhookSignature should reject signature with modified body", async () => {
  const webhookId = "msg_test123";
  const timestamp = TEST_TIMESTAMP;
  const body = '{"event_type":"ping","data":{"success":true}}';
  const modifiedBody = '{"event_type":"ping","data":{"success":false}}';
  const secret = "test_secret_key";

  const signature = await computeWebhookSignature(webhookId, timestamp, body, secret);
  const isValid = await verifyWebhookSignature(webhookId, timestamp, modifiedBody, secret, signature);
  
  assertEquals(isValid, false);
});
