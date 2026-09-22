import { expect, test } from 'bun:test';
import { parseStoreAddress, addressRequiredFields } from './address';
const base = { name: 'Buyer', street1: '1 Main Street', city: 'Town', state: '', zip: '' };
test('US requires state and ZIP; countries without those fields do not invent them', () => {
 expect(parseStoreAddress({ ...base, country: 'US' })).toBeNull();
 expect(parseStoreAddress({ ...base, country: 'US', state: 'NY', zip: '10001' })).not.toBeNull();
 expect(parseStoreAddress({ ...base, country: 'HK', state: 'Hong Kong Island' })).not.toBeNull();
 expect(parseStoreAddress({ ...base, country: 'AE' })).not.toBeNull();
 expect(addressRequiredFields('GB')?.state).toBe(false);
 expect(parseStoreAddress({ ...base, country: 'ZZ' })).toBeNull();
});


test('store address helpers are the shared core contract, not a separate country dataset', async () => {
 const core = await import('@absolutejs/commerce');
 const stores = await import('./address');
 expect(stores.addressRequiredFields).toBe(core.addressRequiredFields);
 expect(stores.supportedAddressCountries).toBe(core.supportedAddressCountries);
 for (const country of core.supportedAddressCountries) expect(stores.addressRequiredFields(country)).toEqual(core.addressRequiredFields(country));
});
