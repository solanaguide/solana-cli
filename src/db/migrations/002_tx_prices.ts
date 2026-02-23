export const migration002 = `
ALTER TABLE transaction_log ADD COLUMN from_price_usd REAL;
ALTER TABLE transaction_log ADD COLUMN to_price_usd REAL;
`;
