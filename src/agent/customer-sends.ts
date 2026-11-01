// Customer sends built on the guarded send_message tool: product image
// cards, STOP/START consent confirmations, and the fixed overload busy reply.
// Split out of agent.ts.

import { readBusyReplyConfig, TEMPORARILY_BUSY_REPLY } from '../busy-reply';
import { createLogger } from '../obs/logger';
import {
  customerRequestedProductPictures,
  productMediaIdsAreAuthorized,
  selectProductMedia,
} from '../product-media';
import type { ToolDef } from '../types';
import { makeSendMessageTool } from './send-guards';
import { getOrCreateCustomer, type SendImageOperation, type SendTextOperation } from './shared';

const log = createLogger();

export function makeShowProductImagesTool(
  sendImage: SendImageOperation | undefined,
  turnKey: string,
  permanentIdempotency: boolean,
  authorizedProductIds: ReadonlySet<number>,
): ToolDef {
  let used = false;
  return {
    name: 'show_product_images',
    description:
      'Send up to three approved catalog product images only after the customer explicitly asks to see pictures. ' +
      'Use only product IDs returned by check_stock in this turn.',
    input_schema: {
      type: 'object',
      properties: {
        product_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Relevant product IDs returned by check_stock; the server groups duplicate variants.',
        },
      },
      required: ['product_ids'],
    },
    execute: async ({ product_ids }, ctx) => {
      if (used) return { ok: false, error: 'Product pictures may be sent only once per customer turn.' };
      if (!sendImage) return { ok: false, error: 'Product image delivery is not configured.' };
      if (!customerRequestedProductPictures(ctx.inboundText)) {
        return { ok: false, error: 'The customer did not explicitly request product pictures.' };
      }
      if (!productMediaIdsAreAuthorized(product_ids, authorizedProductIds)) {
        return {
          ok: false,
          error: 'Product pictures may use only product IDs returned by check_stock in this customer turn.',
        };
      }
      const selection = selectProductMedia(product_ids);
      if (!selection.ok) return selection;
      used = true;

      let sent = 0;
      for (const [index, card] of selection.cards.entries()) {
        const guardedSend = makeSendMessageTool(
          (caption) => sendImage({ ...card.image, caption }),
          `${turnKey}:product-image:${index}:${card.productIds.join('-')}`,
          { permanentIdempotency },
        );
        const result = await guardedSend.execute({ body: card.image.caption }, ctx) as {
          ok?: boolean;
          status?: string;
          delivery_confirmed?: boolean;
          error?: string;
        };
        if (!result.ok) {
          return sent > 0
            ? { ok: true, sent_count: sent, partial: true, error: result.error }
            : { ok: false, sent_count: 0, error: result.error ?? 'Could not send product pictures.' };
        }
        sent += 1;
        if (result.delivery_confirmed === false) {
          return { ok: true, sent_count: sent, delivery_confirmed: false };
        }
      }
      return { ok: true, sent_count: sent, delivery_confirmed: true };
    },
  };
}

export async function sendConsentConfirmation(
  customerId: number,
  eventKey: string,
  body: string,
  sendToCustomer: SendTextOperation,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const result = await makeSendMessageTool(sendToCustomer, eventKey, {
    allowOptedOut: true,
    skipSpinning: true,
    skipDisclosure: true,
    permanentIdempotency: true,
  }).execute({ body }, { customerId, idempotencyKey: eventKey });
  return result as { ok: boolean; status?: string; error?: string };
}

/**
 * Sends one fixed overload response without consulting Gemini. It still uses
 * the normal consent, idempotency, pacing, disclosure, and send-ledger path.
 * The rolling per-customer cooldown is checked inside the global send lock so
 * simultaneous rejected events cannot each send a copy.
 */
export async function sendTemporaryBusyReply(
  phone: string,
  eventKey: string,
  sendToCustomer: SendTextOperation,
  body = TEMPORARILY_BUSY_REPLY,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const customer = getOrCreateCustomer(phone.replace(/\D/g, ''));
    const config = readBusyReplyConfig();
    const result = await makeSendMessageTool(sendToCustomer, `busy:${eventKey}`, {
      skipSpinning: true,
      permanentIdempotency: true,
      minimumRepeatIntervalMs: config.cooldownMinutes * 60_000,
    }).execute(
      { body },
      { customerId: customer.id, idempotencyKey: eventKey },
    );
    return result as { ok: boolean; status?: string; error?: string };
  } catch (err) {
    log.error('temporary busy reply failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: 'Could not send the temporary busy reply.' };
  }
}
