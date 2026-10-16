import type {ClientConfig} from 'pg';
import {databaseTypes} from './codecs';
import {assertNoAmbientPostgresConfig, validateDatabaseConfig, type DatabaseConfig} from './config';

/** Identical explicit credentials, verified TLS, codecs and bounds for pool and dedicated sessions. */
export function postgresClientOptions(config: DatabaseConfig): ClientConfig {
  validateDatabaseConfig(config);
  assertNoAmbientPostgresConfig();
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? {rejectUnauthorized: true, ...(config.ssl.ca ? {ca: config.ssl.ca} : {})} : false,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.statementTimeoutMs + config.connectionTimeoutMs,
    application_name: config.applicationName,
    client_encoding: 'UTF8',
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
    options: `-c timezone=UTC -c datestyle=ISO,YMD -c search_path=public -c statement_timeout=${config.statementTimeoutMs} -c lock_timeout=${config.lockTimeoutMs} -c transaction_timeout=${config.transactionTimeoutMs} -c idle_in_transaction_session_timeout=${config.idleTransactionTimeoutMs}`,
    types: databaseTypes,
  };
}
