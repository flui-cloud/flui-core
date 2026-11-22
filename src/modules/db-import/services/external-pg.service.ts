import { Injectable } from '@nestjs/common';
import { Readable, Writable } from 'node:stream';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ResolvedApp } from '../../db-lifecycle/services/db-pod-exec.service';
import {
  ExternalPgSource,
  psqlOnSource,
  schemaDumpOfSource,
} from '../../db-lifecycle/utils/external-pg.core';

/** A database outside Flui, reached from the pod of the database it is copied into. */
@Injectable()
export class ExternalPgService {
  constructor(private readonly k8s: KubernetesService) {}

  query(
    target: ResolvedApp,
    source: ExternalPgSource,
    password: string,
    sql: string,
  ): Promise<string> {
    return this.run(target, psqlOnSource(source), `${password}\n${sql}`);
  }

  schemaDump(
    target: ResolvedApp,
    source: ExternalPgSource,
    password: string,
  ): Promise<string> {
    return this.run(target, schemaDumpOfSource(source), `${password}\n`);
  }

  /** Runs `command` in the target's pod with `input` on stdin, and returns what it printed. */
  async run(
    target: ResolvedApp,
    command: string,
    input: string,
    shell: 'sh' | 'bash' = 'sh',
  ): Promise<string> {
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    await this.k8s.execStream(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      [shell, '-c', command],
      { stdin: Readable.from([input]), stdout },
      target.container,
    );
    return Buffer.concat(chunks).toString('utf-8');
  }
}
