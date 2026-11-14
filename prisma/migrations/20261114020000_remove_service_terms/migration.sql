BEGIN;

ALTER TABLE products DROP COLUMN service_terms;
ALTER TABLE quotes DROP COLUMN service_terms;
ALTER TABLE orders DROP COLUMN service_terms;

COMMIT;
