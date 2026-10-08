# @absolutejs/commerce-wishes

Wishes/NMI tokenized checkout and refund adapter. `createWishesPayment` accepts private/public keys and optional transaction/query URLs. Raw card details must be collected by the provider; pass only the resulting payment token to the sale operation.

`verifySale({ orderId, amountCents })` queries the merchant report and requires one matching USD sale for the exact amount, with no successful refund/void action. Unknown or ambiguous results remain unresolved and must not be retried as new charges. Applications own durable payment-attempt IDs, access control, settlement ledgers, and webhook replay handling. An order reference alone is not a guarantee of gateway idempotency.

Query contract: https://docs.nmi.com/reference/query. Validate the merchant account’s Wishes endpoints and complete its approved sandbox procedure before enabling live payments. Never ship a private key to the browser.
