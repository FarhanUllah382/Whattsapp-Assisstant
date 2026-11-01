import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHandoffStatusMessage,
  checkHandoffClaimReply,
  createSendHandoffStatusTool,
  type HandoffFacts,
} from '../src/handoff-claims';

test('builds status text only from current-turn facts', () => {
  assert.equal(buildHandoffStatusMessage({ recorded: false, alertStatus: 'none' }), null);
  assert.equal(
    buildHandoffStatusMessage({ recorded: true, alertStatus: 'sent' }),
    "Your request has been recorded, and an alert was sent to Ahmed's WhatsApp. I cannot confirm that he has viewed it yet.",
  );
  assert.equal(
    buildHandoffStatusMessage({ recorded: true, alertStatus: 'pending' }),
    'Your request has been recorded for Ahmed, but the WhatsApp alert is still pending delivery. I cannot confirm that he has viewed it.',
  );
  assert.equal(
    buildHandoffStatusMessage({ recorded: true, alertStatus: 'none' }),
    'Your request has been recorded for Ahmed. I cannot confirm that a WhatsApp alert was delivered or viewed.',
  );
});

test('blocks false media-forwarding claims in English and Roman Urdu', () => {
  assert.equal(checkHandoffClaimReply('I forwarded your screenshot directly to Ahmed.').ok, false);
  assert.equal(checkHandoffClaimReply('Your image was sent to the owner.').ok, false);
  assert.equal(checkHandoffClaimReply('Main ne aapka screenshot Ahmed ko bhej diya hai.').ok, false);
});

test('blocks unverified human actions and promises', () => {
  assert.equal(checkHandoffClaimReply('Ahmed will check and verify it.').ok, false);
  assert.equal(checkHandoffClaimReply('Ahmed viewed it.').ok, false);
  assert.equal(checkHandoffClaimReply('The owner replied to your request.').ok, false);
  assert.equal(checkHandoffClaimReply('Ahmed bhai confirm karenge.').ok, false);
});

test('ordinary send_message cannot narrate handoff state', () => {
  assert.equal(checkHandoffClaimReply('I notified Ahmed about your request.').ok, false);
  assert.equal(checkHandoffClaimReply('Your request was escalated to the owner.').ok, false);
  assert.equal(checkHandoffClaimReply('We have black hoodies in medium.').ok, true);
});

test('only the exact deterministic status body is authorized', () => {
  const body = buildHandoffStatusMessage({ recorded: true, alertStatus: 'sent' });
  assert.ok(body);
  assert.equal(checkHandoffClaimReply(body, body).ok, true);
  assert.equal(checkHandoffClaimReply(`${body} Ahmed will reply soon.`, body).ok, false);
});

test('status tool refuses before notify_owner and sends exact pending and sent states', async () => {
  let facts: HandoffFacts = { recorded: false, alertStatus: 'none' };
  const sent: string[] = [];
  const tool = createSendHandoffStatusTool(
    () => facts,
    async (body) => {
      sent.push(body);
      return { ok: true };
    },
  );

  const before = await tool.execute({}, { customerId: 1 }) as { ok: boolean; error?: string };
  assert.equal(before.ok, false);
  assert.match(before.error ?? '', /notify_owner first/i);
  assert.equal(sent.length, 0);

  facts = { recorded: true, alertStatus: 'pending' };
  assert.deepEqual(await tool.execute({}, { customerId: 1 }), { ok: true });
  assert.equal(sent[0], buildHandoffStatusMessage(facts));

  facts = { recorded: true, alertStatus: 'sent' };
  assert.deepEqual(await tool.execute({}, { customerId: 1 }), { ok: true });
  assert.equal(sent[1], buildHandoffStatusMessage(facts));
});
