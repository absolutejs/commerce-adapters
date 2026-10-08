/** Wishes exposes the NMI-compatible Query API. Contract: https://docs.nmi.com/reference/query */
export type VerifiedWishesSale = {
	id: string;
	orderId: string;
	amountCents: number;
	condition: string;
};
const field = (xml: string, name: string) =>
	new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(xml)?.[1]?.trim() ?? '';
export const verifyWishesSaleReport = (
	xml: string,
	expected: { orderId: string; amountCents: number }
): VerifiedWishesSale => {
	if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(xml))
		throw new Error('Unsupported payment report');
	const matching = [
		...xml.matchAll(/<transaction>([\s\S]*?)<\/transaction>/gu)
	]
		.map((match) => match[1]!)
		.filter(
			(transaction) => field(transaction, 'order_id') === expected.orderId
		);
	if (matching.length !== 1)
		throw new Error(
			'Exactly one matching payment must be verified; keep this request under review'
		);
	const transaction = matching[0]!;
	const condition = field(transaction, 'condition');
	if (
		!['complete', 'pendingsettlement'].includes(condition) ||
		field(transaction, 'currency') !== 'USD'
	)
		throw new Error('Payment has not completed successfully in USD');
	const actions = [...transaction.matchAll(/<action>([\s\S]*?)<\/action>/gu)]
		.map((match) => match[1]!)
		.filter((action) => field(action, 'success') === '1');
	if (
		actions.some((action) =>
			['refund', 'void', 'credit'].includes(field(action, 'action_type'))
		)
	)
		throw new Error('Reversed payment requires manual financial review');
	const sales = actions.filter(
		(action) => field(action, 'action_type') === 'sale'
	);
	if (sales.length !== 1)
		throw new Error('A single successful sale is required');
	const amount = field(sales[0]!, 'amount');
	if (!/^\d+\.\d{2}$/u.test(amount))
		throw new Error('Invalid payment amount');
	const amountCents = Math.round(Number(amount) * 100);
	const id = field(transaction, 'transaction_id');
	if (
		!id ||
		!Number.isSafeInteger(amountCents) ||
		amountCents !== expected.amountCents
	)
		throw new Error('Payment amount does not match this request');

	return { amountCents, condition, id, orderId: expected.orderId };
};

/** A missing query result is not proof of no charge. Require one explicit failed sale. */
export const verifyWishesDeclineReport = (xml: string, expected: { orderId: string; amountCents: number }) => {
 if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('Unsupported payment report');
 const matches = [...xml.matchAll(/<transaction>([\s\S]*?)<\/transaction>/gu)].map((entry) => entry[1]!).filter((entry) => field(entry, 'order_id') === expected.orderId);
 if (matches.length !== 1) throw new Error('No definitive declined payment was found');
 const transaction = matches[0]!;
 const actions = [...transaction.matchAll(/<action>([\s\S]*?)<\/action>/gu)].map((entry) => entry[1]!);
 const sale = actions.filter((entry) => field(entry, 'action_type') === 'sale');
 if (field(transaction, 'condition') !== 'failed' || field(transaction, 'currency') !== 'USD' || actions.some((entry) => field(entry, 'success') === '1') || sale.length !== 1 || field(sale[0]!, 'success') !== '0' || !/^2\d\d$/u.test(field(sale[0]!, 'response_code')) || !/^\d+\.\d{2}$/u.test(field(sale[0]!, 'amount')) || Math.round(Number(field(sale[0]!, 'amount')) * 100) !== expected.amountCents || !field(transaction, 'transaction_id')) throw new Error('The provider has not proven this sale was declined');
 return { id: field(transaction, 'transaction_id'), orderId: expected.orderId, amountCents: expected.amountCents, condition: 'failed' };
};
