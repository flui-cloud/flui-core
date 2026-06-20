import { MessagingEngine } from '../engine/messaging-engine';

export interface MessagingResolveInput {
  appId: string;
  fluiUserId: string;
}

export interface MessagingCredentials {
  username: string;
  password: string;
}

export interface ResolvedMessagingConnection {
  engine: MessagingEngine;
  target: {
    clusterId: string;
    namespace: string;
    podLabelSelector: string;
    /** HTTP monitoring port (serverInfo, streams). */
    port: number;
    /** Client/protocol port (publish, peek). */
    clientPort: number;
  };
  /** Present for authenticated engines (RabbitMQ); absent for NATS. */
  credentials?: MessagingCredentials;
}

export interface MessagingConnectionInfo {
  engine: MessagingEngine;
  label: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}
