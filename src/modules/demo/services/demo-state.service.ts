import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEMO_CONFIG_SINGLETON_ID,
  DemoConfigEntity,
} from '../entities/demo-config.entity';
import { DemoLoopState } from '../enums/demo.enum';

@Injectable()
export class DemoStateService {
  constructor(
    @InjectRepository(DemoConfigEntity)
    private readonly repo: Repository<DemoConfigEntity>,
  ) {}

  async get(): Promise<DemoConfigEntity> {
    let cfg = await this.repo.findOne({
      where: { id: DEMO_CONFIG_SINGLETON_ID },
    });
    if (!cfg) {
      cfg = this.repo.create({ id: DEMO_CONFIG_SINGLETON_ID });
      cfg = await this.repo.save(cfg);
    }
    return cfg;
  }

  async patch(patch: Partial<DemoConfigEntity>): Promise<DemoConfigEntity> {
    await this.get();
    await this.repo.update({ id: DEMO_CONFIG_SINGLETON_ID }, patch);
    return this.get();
  }

  /**
   * Atomically claim the loop: flip IDLE → MIGRATING in one statement so a
   * scheduler tick and an admin trigger can never both start a cycle. Returns
   * true only for the caller that won the transition.
   */
  async claimIdle(): Promise<boolean> {
    await this.get();
    const res = await this.repo.update(
      { id: DEMO_CONFIG_SINGLETON_ID, state: DemoLoopState.IDLE },
      { state: DemoLoopState.MIGRATING },
    );
    return res.affected === 1;
  }
}
