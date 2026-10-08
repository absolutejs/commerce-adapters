import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
	Address,
	CheckoutLineItem,
	CheckoutTotals
} from '@absolutejs/commerce';
import { verifyWishesSaleReport, verifyWishesDeclineReport } from './query';

export const WISHES_COLLECT_URL = 'https://api.wishes.inc/token/Collect.js';
export const WISHES_QUERY_URL = 'https://api.wishes.inc/api/query.php';
export const WISHES_TRANSACTION_URL = 'https://api.wishes.inc/api/transact.php';

export type WishesConfig = {
	privateKey: string;
	publicKey: string;
	transactionUrl?: string;
	queryUrl?: string;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type WishesTokenizedSaleInput = {
	amountCents: number;
	billing?: Partial<Address>;
	currency?: string;
	description?: string;
	email?: string;
	idempotencyKey: string;
	lineItems: CheckoutLineItem[];
	metadata?: Record<string, string>;
	paymentToken: string;
	shipping?: Partial<Address>;
	totals: CheckoutTotals;
};

export type WishesTransaction = {
	authorizationCode: string | null;
	id: string;
	orderId: string;
	responseCode: string;
	responseText: string;
	succeeded: boolean;
	raw: Record<string, string>;
};

const centsToAmount = (cents: number) => {
	if (!Number.isSafeInteger(cents) || cents < 0)
		throw new Error(
			'Wishes amount must be a non-negative integer in cents'
		);

	return (cents / 100).toFixed(2);
};

export const parseWishesTransactionResponse = (
	body: string
): WishesTransaction => {
	const values = Object.fromEntries(new URLSearchParams(body));
	const id = values.transactionid ?? '';
	const orderId = values.orderid ?? '';

	return {
		authorizationCode: values.authcode || null,
		id,
		orderId,
		raw: values,
		responseCode: values.response_code ?? '',
		responseText: values.responsetext ?? '',
		succeeded: values.response === '1' && Boolean(id)
	};
};

const addressFields = (
	prefix: '' | 'shipping_',
	address?: Partial<Address>
): Record<string, string> => {
	if (!address) return {};
	const name = address.name?.trim().split(/\s+/u) ?? [];

	return Object.fromEntries(
		Object.entries({
			[`${prefix}firstname`]: name.shift(),
			[`${prefix}lastname`]: name.join(' '),
			[`${prefix}address1`]: address.street1,
			[`${prefix}address2`]: address.street2,
			[`${prefix}city`]: address.city,
			[`${prefix}state`]: address.state,
			[`${prefix}zip`]: address.zip,
			[`${prefix}country`]: address.country,
			[`${prefix}phone`]: address.phone
		}).filter((entry): entry is [string, string] => Boolean(entry[1]))
	);
};

/** Only a documented response=2 proves a decline; network/system errors remain unknown. */
export class WishesTransactionError extends Error {
	constructor(public readonly outcome: 'declined' | 'unknown', public readonly responseCode = '') {
		super(outcome === 'declined' ? 'The card was declined. Use another payment method.' : 'The payment result is not confirmed. Reconcile before retrying.');
		this.name = 'WishesTransactionError';
	}
}

export const createWishesPayment = (config: WishesConfig) => {
	if (!config.privateKey.trim())
		throw new Error('Wishes private key is required');
	if (!config.publicKey.trim())
		throw new Error('Wishes public key is required');
	const fetcher = config.fetch ?? globalThis.fetch;
	const transactionUrl = config.transactionUrl ?? WISHES_TRANSACTION_URL;
	const postTransaction = async (values: Record<string, string>) => {
		const response = await fetcher(transactionUrl, {
			body: new URLSearchParams({
				security_key: config.privateKey,
				...values
			}),
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			method: 'POST',
			signal: AbortSignal.timeout(30_000)
		});
		const transaction = parseWishesTransactionResponse(
			await response.text()
		);
		if (!response.ok || !transaction.succeeded)
			throw new WishesTransactionError(response.ok && transaction.raw.response === '2' ? 'declined' : 'unknown', transaction.responseCode);
		if (transaction.orderId && transaction.orderId !== values.orderid)
			throw new WishesTransactionError('unknown');

		return transaction;
	};

	return {
		collectScript: {
			publicKey: config.publicKey,
			src: WISHES_COLLECT_URL
		},
		/**
		 * Charge a browser-generated single-use token. CBS never receives a card
		 * number, expiration date, or CVV.
		 */
		createTokenizedCheckout: (input: WishesTokenizedSaleInput) => {
			if (!input.paymentToken.trim())
				throw new Error('Wishes payment token is required');
			if ((input.currency ?? 'USD').toUpperCase() !== 'USD')
				throw new Error(
					'Wishes CBS checkout currently supports USD only'
				);

			return postTransaction({
				...addressFields('', input.billing),
				...addressFields('shipping_', input.shipping),
				amount: centsToAmount(input.amountCents),
				currency: 'USD',
				email: input.email ?? '',
				order_description:
					input.description ?? 'Corporate Brand Stores order',
				orderid: input.idempotencyKey,
				payment_token: input.paymentToken,
				shipping: centsToAmount(input.totals.shippingCents),
				tax: centsToAmount(input.totals.taxCents),
				type: 'sale'
			});
		},
		refundTransaction: (
			transactionId: string,
			idempotencyKey: string,
			amountCents?: number
		) =>
			postTransaction({
				...(amountCents === undefined
					? {}
					: { amount: centsToAmount(amountCents) }),
				orderid: idempotencyKey,
				transactionid: transactionId,
				type: 'refund'
			}),
		verifySale: async (expected: {
			orderId: string;
			amountCents: number;
		}) => {
			if (!/^[a-zA-Z0-9:_-]{1,160}$/u.test(expected.orderId))
				throw new Error('Invalid order reference');
			const response = await (config.fetch ?? fetch)(
				config.queryUrl ?? WISHES_QUERY_URL,
				{
					body: new URLSearchParams({
						order_id: expected.orderId,
						report_type: 'transaction',
						security_key: config.privateKey
					}),
					headers: {
						'content-type': 'application/x-www-form-urlencoded'
					},
					method: 'POST'
				}
			);
			if (!response.ok)
				throw new Error('Payment report could not be retrieved');

			return verifyWishesSaleReport(await response.text(), expected);
		},
		verifyDecline: async (expected: {
			orderId: string;
			amountCents: number;
		}) => {
			if (!/^[a-zA-Z0-9:_-]{1,160}$/u.test(expected.orderId))
				throw new Error('Invalid order reference');
			const response = await (config.fetch ?? fetch)(
				config.queryUrl ?? WISHES_QUERY_URL,
				{
					body: new URLSearchParams({
						order_id: expected.orderId,
						report_type: 'transaction',
						security_key: config.privateKey
					}),
					headers: {
						'content-type': 'application/x-www-form-urlencoded'
					},
					method: 'POST'
				}
			);
			if (!response.ok)
				throw new Error('Payment report could not be retrieved');

			return verifyWishesDeclineReport(await response.text(), expected);
		}
	};
};
export const verifyWishesWebhook = (
	payload: string,
	signatureHeader: string,
	signingKey: string
) => {
	const match = /^t=([^,]+),s=([a-f\d]+)$/iu.exec(signatureHeader.trim());
	if (!match) return false;
	const [, nonce, signature] = match;
	if (!nonce || !signature) return false;
	const observed = Buffer.from(signature, 'hex');
	const expected = Buffer.from(
		createHmac('sha256', signingKey)
			.update(`${nonce}.${payload}`)
			.digest('hex'),
		'hex'
	);

	return (
		observed.length === expected.length &&
		timingSafeEqual(observed, expected)
	);
};
