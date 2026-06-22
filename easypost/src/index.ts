import EasyPostClient from '@easypost/api';
import type {
	Address,
	BuyInput,
	Parcel,
	RateInput,
	ShippingLabel,
	ShippingProvider,
	ShippingRate
} from '@absolutejs/commerce';

export type EasyPostConfig = { apiKey: string };

// EasyPost's SDK types are loose; we narrow the few fields we read.
type EpRate = {
	id: string;
	carrier: string;
	service: string;
	rate: string;
	currency: string;
	delivery_days: number | null;
};
type EpShipment = {
	id: string;
	rates: EpRate[];
};
type EpBought = {
	id: string;
	tracking_code: string;
	selected_rate: EpRate;
	postage_label: { label_url: string };
	tracker?: { public_url?: string | null } | null;
};

const toEasyPostAddress = (address: Address) => ({
	city: address.city,
	company: address.company ?? undefined,
	country: address.country,
	email: address.email ?? undefined,
	name: address.name,
	phone: address.phone ?? undefined,
	state: address.state,
	street1: address.street1,
	street2: address.street2 ?? undefined,
	zip: address.zip
});

const toEasyPostParcel = (parcel: Parcel) => ({
	height: parcel.heightIn,
	length: parcel.lengthIn,
	weight: parcel.weightOz,
	width: parcel.widthIn
});

const mapRate = (rate: EpRate): ShippingRate => ({
	amount: Number(rate.rate),
	carrier: rate.carrier,
	currency: rate.currency,
	estDeliveryDays: rate.delivery_days ?? null,
	id: rate.id,
	service: rate.service
});

const cheapest = (rates: EpRate[]) =>
	rates.reduce((low, rate) => (Number(rate.rate) < Number(low.rate) ? rate : low));

const mapLabel = (bought: EpBought): ShippingLabel => ({
	amount: Number(bought.selected_rate.rate),
	carrier: bought.selected_rate.carrier,
	currency: bought.selected_rate.currency,
	labelUrl: bought.postage_label.label_url,
	rateId: bought.selected_rate.id,
	service: bought.selected_rate.service,
	shipmentId: bought.id,
	trackingNumber: bought.tracking_code,
	trackingUrl: bought.tracker?.public_url ?? null
});

/** Build a `ShippingProvider` backed by an EasyPost account. */
export const createEasyPostProvider = (
	config: EasyPostConfig
): ShippingProvider => {
	const client = new EasyPostClient(config.apiKey);

	const createShipment = (input: RateInput) =>
		client.Shipment.create({
			from_address: toEasyPostAddress(input.from),
			parcel: toEasyPostParcel(input.parcel),
			to_address: toEasyPostAddress(input.to)
		}) as Promise<EpShipment>;

	const buy = (shipmentId: string, rate: EpRate) =>
		client.Shipment.buy(shipmentId, rate as never) as Promise<EpBought>;

	return {
		async buyCheapestLabel(input) {
			const shipment = await createShipment(input);

			return mapLabel(await buy(shipment.id, cheapest(shipment.rates)));
		},
		async buyLabel({ shipmentId, rateId }: BuyInput) {
			const shipment = (await client.Shipment.retrieve(
				shipmentId
			)) as EpShipment;
			const rate =
				shipment.rates.find((entry) => entry.id === rateId) ??
				cheapest(shipment.rates);

			return mapLabel(await buy(shipment.id, rate));
		},
		async rates(input) {
			const shipment = await createShipment(input);

			return shipment.rates.map(mapRate);
		},
		async track(trackingNumber, carrier) {
			const tracker = (await client.Tracker.create({
				carrier,
				tracking_code: trackingNumber
			})) as {
				status: string;
				est_delivery_date?: string | null;
				public_url?: string | null;
			};

			return {
				estDelivery: tracker.est_delivery_date ?? null,
				status: tracker.status,
				trackingUrl: tracker.public_url ?? null
			};
		}
	};
};
