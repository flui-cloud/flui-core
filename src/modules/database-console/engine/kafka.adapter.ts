import { Injectable } from '@nestjs/common';
import * as net from 'node:net';
import { ISocketFactory } from 'kafkajs';
import { KafkaClient } from '../../../kafka-client';
import { KafkaConnectParams } from './kafka-engine';

/**
 * Routes EVERY kafkajs broker connection through a fixed local endpoint (a
 * port-forward tunnel), ignoring the address the broker advertises. This is what
 * makes a wire-protocol client usable from the out-of-cluster control plane: the
 * broker advertises its in-cluster service DNS (so in-cluster apps connect
 * normally), but the console always dials the tunnel.
 *
 * Single-broker today. For a multi-broker StatefulSet the host would be mapped to
 * the matching per-pod tunnel (broker N -> kafka-N pod -> its own tunnel); the
 * library is already multi-broker, only this resolver would grow.
 */
export function tunnelSocketFactory(
  host: string,
  port: number,
): ISocketFactory {
  return ({ onConnect }) => {
    const socket = net.connect({ host, port }, onConnect);
    socket.setKeepAlive(true, 60_000);
    socket.setNoDelay(true);
    return socket;
  };
}

/**
 * Builds a Kafka client bound to a reachable endpoint. The endpoint is a tunnel
 * the query service opened; the socket factory pins all connections to it.
 */
@Injectable()
export class KafkaAdapter {
  connect(params: KafkaConnectParams): KafkaClient {
    return new KafkaClient({
      brokers: [`${params.host}:${params.port}`],
      socketFactory: tunnelSocketFactory(params.host, params.port),
      ssl: params.ssl,
      sasl: params.sasl
        ? {
            mechanism: params.sasl.mechanism,
            username: params.sasl.username,
            password: params.sasl.password,
          }
        : undefined,
    });
  }
}
