import { expect, test } from 'bun:test';
import { createWishesPayment, WishesTransactionError } from './index';
import { verifyWishesDeclineReport } from './query';
const input = { amountCents: 1000, paymentToken: 'test-token', idempotencyKey: 'attempt-1', lineItems: [], totals: { subtotalCents: 1000, discountCents: 0, shippingCents: 0, taxCents: 0 } };
test('only an explicit decline authorizes a new attempt', async () => {
 for (const [response, outcome] of [['2','declined'], ['3','unknown'], ['1','unknown']] as const) {
  const adapter = createWishesPayment({ publicKey:'public', privateKey:'private', fetch: async () => new Response(`response=${response}&response_code=200`) });
  try { await adapter.createTokenizedCheckout(input); throw new Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(WishesTransactionError); expect((error as WishesTransactionError).outcome).toBe(outcome); }
 }
});
test('missing reports and ambiguous failures never prove no charge', () => {
 const expected = { orderId: 'attempt-1', amountCents: 1000 };
 const report = '<transaction><transaction_id>1</transaction_id><order_id>attempt-1</order_id><currency>USD</currency><condition>failed</condition><action><action_type>sale</action_type><success>0</success><response_code>200</response_code><amount>10.00</amount></action></transaction>';
 expect(verifyWishesDeclineReport(report, expected).id).toBe('1');
 for (const text of ['', report+report, report.replace('200','420'), report.replace('10.00','20.00'), report.replace('<success>0','<success>1')]) expect(() => verifyWishesDeclineReport(text, expected)).toThrow();
});
