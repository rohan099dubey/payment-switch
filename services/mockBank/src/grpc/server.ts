import { Server, ServerCredentials } from '@grpc/grpc-js';
import { BankServiceService, type BankServiceServer } from '@switch/proto-gen/bank/v1';

export interface RunningGrpcServer {
  port: number;
  /** Stops accepting calls, lets in-flight calls finish, forces shutdown after `graceMs`. */
  shutdown: (graceMs: number) => Promise<void>;
}

export async function startGrpcServer(handlers: BankServiceServer, port: number): Promise<RunningGrpcServer> {
  const server = new Server();
  server.addService(BankServiceService, handlers);

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, ServerCredentials.createInsecure(), (err, actualPort) => {
      if (err) reject(err);
      else resolve(actualPort);
    });
  });

  return {
    port: boundPort,
    shutdown: (graceMs) =>
      new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, graceMs);
        server.tryShutdown(() => {
          clearTimeout(force);
          resolve();
        });
      }),
  };
}
