-- Databases for the registry records the Scout looks up. It adds one REST table per identifier while it runs:
-- lei_<lei> for a GLEIF LEI record and edgar_<10-digit CIK> for an SEC EDGAR submissions file.

CREATE LIGHTNING DATABASE PROV_GLEIF DESCRIBE BY "Provenance GLEIF LEI records, one table per LEI";

CREATE LIGHTNING DATABASE PROV_SEC DESCRIBE BY "Provenance SEC EDGAR submissions, one table per CIK";
