/** A fully valid public seller-enquiry body (synthetic data only). */
export const valid = () => ({
  contact_name: 'Jane Owner',
  contact_role: 'OWNER',
  email: ' Jane@Example.com ',
  preferred_contact_method: 'EMAIL',
  contact_country: 'gb',
  asset_type: 'CASINO',
  asset_country: 'MT',
  asset_name_confidential: 'YES',
  asset_description: 'A licensed casino with a hotel attached, operating for ten years.',
  operating_status: 'OPERATING',
  authority_declaration: 'UNSURE',
  sale_timing: 'EXPLORING',
  confidentiality_preference: 'DISCUSS_WITH_BROKER',
  privacy_acknowledged: true,
  accuracy_declared: true,
  idempotency_key: 'abcdefghijklmnop1234',
});
