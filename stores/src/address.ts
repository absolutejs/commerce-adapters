import { addressRequiredFields, type Address } from "@absolutejs/commerce";
export { addressRequiredFields, supportedAddressCountries } from "@absolutejs/commerce";
export const parseStoreAddress = (value: unknown): Address | null => {
 if (!value || typeof value !== 'object') return null;
 const raw = value as Record<string, unknown>;
 const text = (key: string) => typeof raw[key] === 'string' ? raw[key].trim() : '';
 const address: Address = { city: text('city'), country: text('country').toUpperCase(), name: text('name'), state: text('state').toUpperCase(), street1: text('street1'), zip: text('zip'), ...(text('street2') ? { street2: text('street2') } : {}), ...(text('phone') ? { phone: text('phone') } : {}) };
 const required = addressRequiredFields(address.country);
 if (!required || !address.name || !address.street1 || (required.city && !address.city) || (required.state && !address.state) || (required.zip && !address.zip)) return null;
 return address;
};
