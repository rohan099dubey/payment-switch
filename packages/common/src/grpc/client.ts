import { credentials, type ChannelCredentials, type ClientOptions } from '@grpc/grpc-js';

export type ServiceClientConstructor<T> = new (
  address: string,
  creds: ChannelCredentials,
  options?: Partial<ClientOptions>,
) => T;

/**
 * Channel options for every internal client. Built-in retries are disabled so every
 * retry is explicit (`withRetry`) and counted in metrics. Keepalive pings only while a
 * call is active, so idle channels do not trip a server's ping policing.
 */
export const CLIENT_OPTIONS: Readonly<Partial<ClientOptions>> = {
  'grpc.enable_retries': 0,
  'grpc.keepalive_time_ms': 20_000,
  'grpc.keepalive_timeout_ms': 5_000,
  'grpc.keepalive_permit_without_calls': 0,
};

/** Builds a generated client (e.g. `BankServiceClient`) for an internal address. */
export function makeClient<T>(ServiceCtor: ServiceClientConstructor<T>, address: string): T {
  return new ServiceCtor(address, credentials.createInsecure(), { ...CLIENT_OPTIONS });
}
