-- The synthetic ERP vendor master (service erp-db in docker-compose.yml) as a Zetaris JDBC data source.

CREATE DATASOURCE PROV_ERP DESCRIBE BY "Synthetic ERP vendor master" OPTIONS (
    jdbcdriver "org.postgresql.Driver",
    jdbcurl "jdbc:postgresql://erp-db:5432/erp",
    username "erp",
    password "{{ERP_DB_PASSWORD}}"
);

REGISTER DATASOURCE TABLES FROM PROV_ERP;
