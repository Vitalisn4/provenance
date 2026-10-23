-- Synthetic ERP vendor master: supplier records as procurement staff typed them. The real and seeded errors,
-- the expected decision for each supplier and the learning/held-out split are in data/answer-key.json.
-- Postgres runs this file only when it creates an empty database; after editing it, reload with
-- docker compose up -d --force-recreate --renew-anon-volumes erp-db
CREATE TABLE vendor_master (
    vendor_id   text PRIMARY KEY,
    vendor_name text NOT NULL,
    country     char(2) NOT NULL,
    claimed_lei text,
    claimed_cik text,
    claimed_sic text
);

INSERT INTO vendor_master VALUES
    ('V-1001', 'International Business Machines Corp', 'US', NULL, '51143', '3570'),
    ('V-1002', 'Siemens AG', 'DE', '5299008LSFRCSQJPMO62', NULL, NULL),
    ('V-1003', 'Kappa Pay Cameroon S.A', 'CM', '2549004XTX9UX53WO914', NULL, NULL),
    ('V-1004', 'Cisco Systems, Inc.', 'US', '549300LKFJ962MZ46593', '858877', '3576'),
    ('V-1005', 'The Procter & Gamble Company', 'US', '2572IBTT8CCZW6AU4141', '80424', '2840'),
    ('V-1006', 'HP Inc.', 'US', 'WHKXQACZ14C5XRO8LW03', '47217', '3570'),
    ('V-1007', 'United Parcel Service, Inc.', 'US', 'D01LMJZU09ULLNCY6Z23', '1090727', '4210'),
    ('V-1008', 'Oracle Corporation', 'US', '254900H5XMH7XWWGM795', '1341439', '7372'),
    ('V-1009', 'Intel Corporation', 'US', '549300RISM2SH22CG297', '50863', '3674'),
    ('V-1010', 'Ford Motor Company', 'US', '549300ZGWE2VQHZWVW14', '37996', '3711'),
    ('V-1011', 'Microsoft Corporation', 'US', '335800E7D8TEYEZOH405', '789019', '7372'),
    ('V-1012', 'Ford Motor Company A/S', 'DK', '549300IDU9WRO0NMRA62', NULL, NULL),
    ('V-1013', 'PepsiCo Sales, Inc.', 'US', '549300X0T62B72FU6Q21', NULL, NULL),
    ('V-1014', '3M Innovative Properties Company', 'US', 'N1UJQ4IJG4SH8I5SLV06', NULL, NULL),
    ('V-1015', 'Mitsubishi Caterpillar Forklift America Inc.', 'US', '549300QFGGPU2T3O6Y49', NULL, NULL),
    ('V-1016', 'Deere-Hitachi Construction Machinery Corporation', 'US', '549300RW8R22BJXY6F44', NULL, NULL),
    ('V-1017', 'Caterpiller Inc', 'US', 'WRJR7GS4GTRECRRTVX92', '18230', '3531'),
    ('V-1018', 'John Deere', 'US', 'PWFTNG3EI0Y73OXWDH08', '315189', '3523'),
    ('V-1019', 'Honeywell Intl', 'US', 'ISRPG12PN4EIEOEMW547', '773840', '3724'),
    ('V-1020', 'Philips', 'NL', 'H1FJE8H61JGM1JSGM897', '313216', '3844'),
    ('V-1021', 'Wal-Mart Stores', 'US', 'Y87794H0US1R65VBXU25', '104169', '5331'),
    ('V-1022', 'Douala Cold Chain SARL', 'CM', NULL, NULL, NULL),
    ('V-1023', 'Accra Ledger Services Ltd', 'GH', NULL, NULL, NULL),
    ('V-1024', 'Nairobi Freight Partners Ltd', 'KE', NULL, NULL, NULL),
    ('V-1025', 'Kumasi Agro Supplies Ltd', 'GH', NULL, NULL, NULL),
    ('V-1026', 'Mombasa Packaging Works Ltd', 'KE', NULL, NULL, NULL),
    ('V-1027', 'SAP SE', 'DE', '529900D6BF99LW9R2E68', '1000184', '7372'),
    ('V-1028', 'Apple Inc.', 'US', 'HWUPKR0MPOU8FGXBT394', '320193', '3571'),
    ('V-1029', 'Nokia Oyj', 'FI', '549300A0JPRWG1KI7U06', '924613', '3663'),
    ('V-1030', 'Siemens A/S', 'DK', NULL, NULL, NULL),
    ('V-1031', 'Ericsson', 'SE', NULL, NULL, NULL);
