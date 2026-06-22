# @absolutejs/commerce-resend

[Resend](https://resend.com) transactional-email adapter for
[`@absolutejs/commerce`](https://github.com/absolutejs/commerce). Implements the
`EmailProvider` contract so you can send the branded order / shipping / proof /
quote emails built with `renderEmail` from the commerce host.

```ts
import { renderEmail, type EmailTheme } from '@absolutejs/commerce';
import { createResendEmailProvider } from '@absolutejs/commerce-resend';

const email = createResendEmailProvider({
	apiKey: process.env.RESEND_API_KEY!,
	from: 'The Embroidery Place <hi@shop.com>'
});

await email.send({
	to: customer.email,
	subject: 'Order #ABCD1234 confirmed',
	html: renderEmail(theme, { preheader: '…', heading: 'Order confirmed', intro: '…' })
});
```

Sends are best-effort (errors logged, never thrown). Use the Resend test
sender `onboarding@resend.dev` until your domain is verified.

## License

Apache-2.0.
