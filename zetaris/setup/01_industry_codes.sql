-- US SIC industry codes from company_dns (Apache-2.0), which the Evidence Judge checks claimed codes against.
-- Uses the V4 API; V3 is deprecated. Adapted from github.com/zetaris/getting-started:
-- open_data/rest_apis/sql/rate_limited/12_company_dns_create.sql

CREATE LIGHTNING DATABASE PROV_CODES DESCRIBE BY "Provenance industry code reference lists from company_dns";

CREATE LIGHTNING REST TABLE sic_raw FROM PROV_CODES REQUEST(
    endpoint "https://company-dns.mediumroast.io/V4.0/na/sic/code/%25",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "{{SEC_USER_AGENT}}"
) BODY ();

CREATE SCHEMASTORE CONTAINER prov;

-- V4 calls the 4-digit SIC code a "class".
CREATE OR REPLACE SCHEMASTORE VIEW sic_codes WITH CONTAINER prov AS
SELECT sic.class_id AS sic_code, sic.class_desc AS description
FROM prov_codes.sic_raw
LATERAL VIEW explode(data) AS sic;

-- A REST table calls the API on every query; the cache answers from memory instead. Replacing the view above
-- or restarting Zetaris drops the cache, so every setup run re-creates it.
CACHE TABLE prov_codes.sic_raw;
