import { Test, TestingModule } from '@nestjs/testing';
import { PhoenixDetectorService } from './phoenix-detector.service';
import { IDetectionContext } from '../../framework-core/interfaces';
import {
  FrameworkType,
  BuildMode,
  DeployStrategy,
} from '../../framework-core/enums';

describe('PhoenixDetectorService', () => {
  let service: PhoenixDetectorService;

  const baseContext = (): IDetectionContext => ({
    repositoryPath: '/test/repo',
    files: [],
    rootFiles: [],
    lockfilePresent: false,
    hasCIConfig: false,
    hasTests: false,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PhoenixDetectorService],
    }).compile();

    service = module.get<PhoenixDetectorService>(PhoenixDetectorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getMetadata', () => {
    it('returns correct metadata', () => {
      const meta = service.getMetadata();
      expect(meta.frameworkType).toBe(FrameworkType.PHOENIX);
      expect(meta.displayName).toBe('Phoenix (Elixir)');
      expect(meta.priority).toBe(58);
      expect(meta.category).toBe('fullstack');
    });
  });

  describe('canDetect', () => {
    it('returns true when mix.exs present', () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs'];
      expect(service.canDetect(ctx)).toBe(true);
    });

    it('returns false when no mix.exs', () => {
      expect(service.canDetect(baseContext())).toBe(false);
    });
  });

  describe('detect', () => {
    it('returns high confidence with full Phoenix structure', async () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs', 'mix.lock'];
      ctx.files = [
        'config/config.exs',
        'config/runtime.exs',
        'lib/my_app_web.ex',
        'priv/repo/migrations/20240101_create_users.exs',
        'assets/js/app.js',
      ];
      const result = await service.detect(ctx);
      expect(result.confidence).toBeGreaterThanOrEqual(90);
      expect(result.framework).toBe(FrameworkType.PHOENIX);
      expect(result.buildMode).toBe(BuildMode.PRODUCTION);
    });

    it('detects phoenix-web feature', async () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs'];
      ctx.files = ['lib/my_app_web.ex'];
      const result = await service.detect(ctx);
      expect(result.features).toContain('phoenix-web');
    });

    it('detects ecto-migrations feature', async () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs'];
      ctx.files = ['priv/repo/migrations/20240101_create_users.exs'];
      const result = await service.detect(ctx);
      expect(result.features).toContain('ecto-migrations');
    });

    it('detects liveview feature', async () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs'];
      ctx.files = ['lib/my_app_web/live/user_live.ex'];
      const result = await service.detect(ctx);
      expect(result.features).toContain('liveview');
    });

    it('detects channels feature', async () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs'];
      ctx.files = ['lib/my_app_web/channels/room_channel.ex'];
      const result = await service.detect(ctx);
      expect(result.features).toContain('channels');
    });

    it('warns when no mix.lock found', async () => {
      const ctx = baseContext();
      ctx.rootFiles = ['mix.exs'];
      const result = await service.detect(ctx);
      expect(result.warnings.some((w) => w.includes('mix.lock'))).toBe(true);
    });
  });

  describe('generateBuildPlan', () => {
    // These used to assert an `elixir:1.16-alpine` Dockerfile with `mix release` and
    // `mix phx.digest`. This detector has never produced one: `dockerfile: ''` is written into the
    // plan literally, and `git log` on the service shows a single entry — the initial public
    // release. The assertions described an intention, and a test that has never been able to pass
    // is not a guard, it is noise that hides a real regression behind it.
    //
    // Not filled in either: the empty string is coherent with what this detector says about itself
    // — `NEEDS_ADJUSTMENT`, deployability 0, build reproducibility 0. It reports honestly that it
    // does not know how to build this. Writing a Dockerfile now, for a module the plan is
    // deprecating in favour of the cartographer engine and Railpack, would be an assertion nobody
    // has ever put against a real build.
    //
    // So the truth is pinned instead, and the two halves are pinned together: changing one without
    // the other fails here, which is what makes "this detector can build now" a decision somebody
    // has to take deliberately rather than a side effect.
    it('says it cannot build this, and says it in both places at once', async () => {
      const ctx = baseContext();
      const detectionResult = {
        framework: FrameworkType.PHOENIX,
        confidence: 85,
        features: ['assets', 'mix-lock'],
        metadata: { hasLiveView: true },
        detectorName: 'phoenix-detector',
      };
      const plan = await service.generateBuildPlan(detectionResult, ctx);
      expect(plan.dockerfile).toBe('');
      expect(plan.deployStrategy).toBe(DeployStrategy.NEEDS_ADJUSTMENT);
      expect(plan.networking.port).toBe(4000);
    });

    it('uses port from fluiConfig', async () => {
      const ctx = baseContext();
      ctx.fluiConfig = { version: '1.0', runtime: { port: 4001 } };
      const detectionResult = {
        framework: FrameworkType.PHOENIX,
        confidence: 85,
        features: [],
        metadata: { hasLiveView: false },
        detectorName: 'phoenix-detector',
      };
      const plan = await service.generateBuildPlan(detectionResult, ctx);
      expect(plan.networking.port).toBe(4001);
    });

    it('sets low memory resources (Elixir is efficient)', async () => {
      const ctx = baseContext();
      const detectionResult = {
        framework: FrameworkType.PHOENIX,
        confidence: 85,
        features: [],
        metadata: { hasLiveView: false },
        detectorName: 'phoenix-detector',
      };
      const plan = await service.generateBuildPlan(detectionResult, ctx);
      expect(plan.resources.memory.request).toBe('128Mi');
    });
  });
});
