import { Test, TestingModule } from '@nestjs/testing';
import { DockerfileDetectorService } from './dockerfile-detector.service';
import { IDetectionContext } from '../../framework-core/interfaces';
import { FrameworkType } from '../../framework-core/enums';
import { promises as fs } from 'node:fs';

// Mock fs module
jest.mock('node:fs', () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

describe('DockerfileDetectorService', () => {
  let service: DockerfileDetectorService;
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DockerfileDetectorService],
    }).compile();

    service = module.get<DockerfileDetectorService>(DockerfileDetectorService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getMetadata', () => {
    it('should return correct metadata', () => {
      const metadata = service.getMetadata();

      expect(metadata.frameworkType).toBe(FrameworkType.DOCKERFILE);
      expect(metadata.displayName).toBe('Dockerfile (Custom)');
      expect(metadata.priority).toBe(100);
      expect(metadata.category).toBe('passthrough');
      expect(metadata.official).toBe(true);
    });
  });

  describe('canDetect', () => {
    it('should return true if Dockerfile exists in root', () => {
      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile', 'package.json', 'README.md'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const result = service.canDetect(context);
      expect(result).toBe(true);
    });

    it('should return false if Dockerfile does not exist', () => {
      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['package.json', 'README.md'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const result = service.canDetect(context);
      expect(result).toBe(false);
    });
  });

  describe('detect', () => {
    it('should return 100% confidence if Dockerfile exists', async () => {
      const dockerfileContent = `
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
      `;

      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const result = await service.detect(context);

      expect(result.framework).toBe(FrameworkType.DOCKERFILE);
      expect(result.confidence).toBe(100);
      expect(result.metadata.exposedPort).toBe(3000);
      expect(result.metadata.baseImage).toBe('node:20-alpine');
    });

    it('should warn if no EXPOSE directive found', async () => {
      const dockerfileContent = `
FROM node:20-alpine
WORKDIR /app
CMD ["npm", "start"]
      `;

      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const result = await service.detect(context);

      expect(result.warnings).toContain(
        'No EXPOSE directive found in Dockerfile. You will need to specify the port in .flui.yaml',
      );
      expect(result.metadata.exposedPort).toBeUndefined();
    });

    it('should warn if using :latest tag', async () => {
      const dockerfileContent = `
FROM node:latest
WORKDIR /app
EXPOSE 8080
      `;

      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const result = await service.detect(context);

      expect(result.warnings).toContain(
        'Using :latest tag in base image is not recommended for production deployments',
      );
    });

    it('should return 0% confidence if Dockerfile does not exist', async () => {
      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['package.json'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const result = await service.detect(context);

      expect(result.confidence).toBe(0);
    });
  });

  describe('generateBuildPlan', () => {
    it('should generate build plan with Dockerfile content', async () => {
      const dockerfileContent = `
FROM node:20-alpine
EXPOSE 3000
      `;

      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const detectionResult = {
        framework: FrameworkType.DOCKERFILE,
        confidence: 100,
        detectorName: 'dockerfile-passthrough',
        metadata: {
          exposedPort: 3000,
        },
      };

      const buildPlan = await service.generateBuildPlan(
        detectionResult,
        context,
      );

      expect(buildPlan.framework).toBe(FrameworkType.DOCKERFILE);
      expect(buildPlan.dockerfile).toBe(dockerfileContent);
      expect(buildPlan.networking.port).toBe(3000);
      expect(buildPlan.buildContext).toBe('.');
      expect(buildPlan.metadata.templateVersion).toBe('passthrough');
    });

    it('should use port from .flui.yaml if provided', async () => {
      const dockerfileContent = 'FROM node:20-alpine';
      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
        fluiConfig: {
          version: '1.0',
          runtime: {
            port: 8080,
          },
        },
      };

      const detectionResult = {
        framework: FrameworkType.DOCKERFILE,
        confidence: 100,
        detectorName: 'dockerfile-passthrough',
      };

      const buildPlan = await service.generateBuildPlan(
        detectionResult,
        context,
      );

      expect(buildPlan.networking.port).toBe(8080);
    });

    it('should use default port 8080 if not specified', async () => {
      const dockerfileContent = 'FROM node:20-alpine';
      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
      };

      const detectionResult = {
        framework: FrameworkType.DOCKERFILE,
        confidence: 100,
        detectorName: 'dockerfile-passthrough',
      };

      const buildPlan = await service.generateBuildPlan(
        detectionResult,
        context,
      );

      expect(buildPlan.networking.port).toBe(8080);
    });

    it('should include health check if configured in .flui.yaml', async () => {
      const dockerfileContent = 'FROM node:20-alpine';
      mockFs.readFile.mockResolvedValue(dockerfileContent);

      const context: IDetectionContext = {
        repositoryPath: '/test/repo',
        files: [],
        rootFiles: ['Dockerfile'],
        lockfilePresent: false,
        hasCIConfig: false,
        hasTests: false,
        fluiConfig: {
          version: '1.0',
          runtime: {
            port: 3000,
            healthCheck: {
              enabled: true,
              path: '/api/health',
              port: 3000,
            },
          },
        },
      };

      const detectionResult = {
        framework: FrameworkType.DOCKERFILE,
        confidence: 100,
        detectorName: 'dockerfile-passthrough',
      };

      const buildPlan = await service.generateBuildPlan(
        detectionResult,
        context,
      );

      expect(buildPlan.healthCheck).toBeDefined();
      expect(buildPlan.healthCheck.enabled).toBe(true);
      expect(buildPlan.healthCheck.path).toBe('/api/health');
    });
  });
});
