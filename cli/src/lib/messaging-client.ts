import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface AppMessaging {
  applicationId: string;
  connected: boolean;
  url: string | null;
  account: string | null;
}

export interface QueueView {
  name: string;
  subjects: string[];
  maxAgeHours: number;
  maxDeliver: number;
  waiting: number;
  inFlight: number;
  redelivered: number;
  consumers: number;
  deadLetters: number | null;
}

/** An application's own account on the NATS its cluster shares. */
export class MessagingClient {
  constructor(private readonly api: ApiClient) {}

  static fromConfig(): MessagingClient {
    const cfg = new ConfigStorage();
    return new MessagingClient(
      new ApiClient({
        baseUrl: cfg.getApiUrlOrThrow(),
        apiKey: cfg.getApiKeyOrThrow(),
      }),
    );
  }

  get(applicationId: string): Promise<AppMessaging> {
    return this.api.get(
      `/applications/${encodeURIComponent(applicationId)}/messaging`,
    );
  }

  connect(applicationId: string): Promise<AppMessaging> {
    return this.api.put(
      `/applications/${encodeURIComponent(applicationId)}/messaging`,
    );
  }

  scale(
    applicationId: string,
    q: {
      stream: string;
      consumer: string;
      lagThreshold: number;
      min: number;
      max: number;
    },
  ): Promise<AppMessaging> {
    return this.api.put(
      `/applications/${encodeURIComponent(applicationId)}/messaging/scaling`,
      q,
    );
  }

  stopScaling(applicationId: string): Promise<AppMessaging> {
    return this.api.delete(
      `/applications/${encodeURIComponent(applicationId)}/messaging/scaling`,
    );
  }

  queues(applicationId: string): Promise<QueueView[]> {
    return this.api.get(
      `/applications/${encodeURIComponent(applicationId)}/messaging/queues`,
    );
  }

  createQueue(
    applicationId: string,
    q: {
      name: string;
      maxAgeHours: number;
      maxDeliver: number;
      deadLetter: boolean;
    },
  ): Promise<QueueView[]> {
    return this.api.post(
      `/applications/${encodeURIComponent(applicationId)}/messaging/queues`,
      q,
    );
  }

  deleteQueue(applicationId: string, name: string): Promise<QueueView[]> {
    return this.api.delete(
      `/applications/${encodeURIComponent(applicationId)}/messaging/queues/${encodeURIComponent(name)}`,
    );
  }

  disconnect(applicationId: string): Promise<void> {
    return this.api.delete(
      `/applications/${encodeURIComponent(applicationId)}/messaging`,
    );
  }
}
