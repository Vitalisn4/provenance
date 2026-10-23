-- Synthetic ERP vendor master: supplier records as procurement staff typed them, each error explained.
CREATE TABLE vendor_master (
    vendor_id   text PRIMARY KEY,
    vendor_name text NOT NULL,
    country     char(2) NOT NULL,
    claimed_lei text,
    claimed_cik text,
    claimed_sic text
);

INSERT INTO vendor_master VALUES
    -- Real data gap: IBM's SIC code in EDGAR (3570) is not in the company_dns code list.
    ('V-1001', 'IBM Corp', 'US', NULL, '51143', '3570'),
    -- Seeded error: a German supplier recorded with Siemens AB's (Sweden) LEI.
    ('V-1002', 'Siemens AG', 'DE', '5299008LSFRCSQJPMO62', NULL, NULL),
    -- Country with little registry coverage: missing evidence gives "Fix: request documents", not a penalty.
    ('V-1003', 'Kappa Pay Cameroon', 'CM', NULL, NULL, NULL);
