import { expect, test } from 'bun:test';
import { verifyWishesSaleReport } from './query';
const transaction =
	'<transaction><transaction_id>123</transaction_id><order_id>cbs-bill:test</order_id><condition>complete</condition><currency>USD</currency><action><amount>50.00</amount><action_type>sale</action_type><success>1</success></action></transaction>';
const expected = { amountCents: 5000, orderId: 'cbs-bill:test' };
test('reconciliation requires one exact successful sale with matching amount and identity', () => {
	expect(verifyWishesSaleReport(transaction, expected)).toMatchObject({
		amountCents: 5000,
		id: '123'
	});
	expect(() =>
		verifyWishesSaleReport(transaction, { ...expected, amountCents: 5001 })
	).toThrow('amount');
	expect(() =>
		verifyWishesSaleReport(transaction, { ...expected, orderId: 'other' })
	).toThrow('Exactly one');
	expect(() =>
		verifyWishesSaleReport(transaction + transaction, expected)
	).toThrow('Exactly one');
	expect(() =>
		verifyWishesSaleReport(
			transaction.replace('complete', 'pending'),
			expected
		)
	).toThrow('not completed');
	expect(() =>
		verifyWishesSaleReport(transaction.replace('USD', 'CAD'), expected)
	).toThrow('USD');
	expect(() =>
		verifyWishesSaleReport(
			transaction.replace(
				'</transaction>',
				'<action><action_type>refund</action_type><success>1</success></action></transaction>'
			),
			expected
		)
	).toThrow('Reversed');
});
