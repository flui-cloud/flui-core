import { Injectable } from '@nestjs/common';

/**
 * Name of the repository secret that carries the per-application webhook
 * credential. One constant, read by the generator that writes the reference
 * into the workflow and by the service that writes the value into the
 * repository, so the two cannot drift into naming different secrets.
 */
export const FLUI_WEBHOOK_SECRET = 'FLUI_WEBHOOK_TOKEN';

export interface WorkflowParams {
  branchName: string;
  githubUsername: string;
  repoName: string;
  fluiAppId: string;
  fluiWebhookUrl: string;
  framework: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  nodeVersion?: string;
  javaVersion?: string;
  dotnetVersion?: string;
  /**
   * When true, skip the `Notify Flui` curl steps from the generated workflow.
   * The Flui backend still discovers build completion via its build watcher
   * polling GitHub — the webhook is just a latency optimization. Default
   * false (webhook + polling, webhook wins when both work).
   */
  backendPollingOnly?: boolean;
}

export interface WorkflowParamsV3 {
  branchName: string;
  githubOwner: string;
  /** Git repo name — used as the GHCR package name (1:1 with the repo). */
  repoName: string;
  /**
   * Optional sub-path for monorepo flows (multiple flui.yaml in the same repo).
   * When set, the GHCR image becomes `ghcr.io/{owner}/{repoName}/{subPath}:{sha}`
   * and the push trigger is scoped to that path (plus Dockerfile + workflow file).
   */
  subPath?: string;
  /** Dockerfile path relative to repo root (default: {context}/Dockerfile). */
  dockerfilePath?: string;
  /** Docker build context relative to repo root (default: .). */
  buildContext?: string;
  /** `build.args` from the manifest — baked into the image via `--build-arg`. */
  buildArgs?: Record<string, string>;
  /** Workflow filename (e.g. flui-my-app.yml) — used in the paths filter. */
  workflowFileName?: string;
  appSlug: string;
  fluiAppId: string;
  fluiWebhookUrl: string;
  backendPollingOnly?: boolean;
}

export interface DockerfileParams {
  framework: string;
  nodeVersion?: string;
  javaVersion?: string;
  dotnetVersion?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  port: number;
  appName?: string;
  buildTool?: 'maven' | 'gradle';
}

export interface FrameworkDefaults {
  port: number;
  resourceProfile: string;
  healthcheckPath: string;
}

/**
 * Generates GitHub Actions workflow YAML and Dockerfiles in memory.
 * No file I/O — all outputs are returned as strings for callers to commit.
 */
@Injectable()
export class WorkflowGeneratorService {
  getFrameworkDefaults(framework: string): FrameworkDefaults {
    const fw = framework.toLowerCase().replaceAll('_', '-');
    const defaults: Record<string, FrameworkDefaults> = {
      nextjs: {
        port: 3000,
        resourceProfile: 'small',
        healthcheckPath: '/api/health',
      },
      nuxt: {
        port: 3000,
        resourceProfile: 'small',
        healthcheckPath: '/api/health',
      },
      angular: { port: 80, resourceProfile: 'small', healthcheckPath: '/' },
      'svelte-kit': {
        port: 3000,
        resourceProfile: 'small',
        healthcheckPath: '/',
      },
      nestjs: {
        port: 3000,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
      express: {
        port: 3000,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
      'spring-boot': {
        port: 8080,
        resourceProfile: 'medium',
        healthcheckPath: '/actuator/health',
      },
      django: {
        port: 8000,
        resourceProfile: 'small',
        healthcheckPath: '/health/',
      },
      fastapi: {
        port: 8000,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
      'aspnet-core': {
        port: 80,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
      rails: { port: 3000, resourceProfile: 'small', healthcheckPath: '/up' },
      laravel: {
        port: 80,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
      go: { port: 8080, resourceProfile: 'small', healthcheckPath: '/health' },
      flask: {
        port: 5000,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
      phoenix: {
        port: 4000,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      },
    };
    return (
      defaults[fw] ?? {
        port: 3000,
        resourceProfile: 'small',
        healthcheckPath: '/health',
      }
    );
  }

  /**
   * The two steps that tell Flui a build finished.
   *
   * `X-Flui-Token` is not a secret that merely leaks when read: it is the
   * deploy trigger. Whoever holds it can post
   * `{appId, imageRef, status:"success"}` and have Flui roll out an image of
   * their choosing on that application. So it travels as a repository secret
   * and never as text in the file we commit into somebody else's repository.
   *
   * Deliberately no `||` fallback, unlike the GHCR login above: an empty token
   * would call the webhook with no credential, be rejected, and leave nothing
   * in the log to read a cause out of. The step stops first and says why.
   */
  private notifyFluiSteps(
    webhookUrl: string,
    labels: { success: string; failure: string },
  ): string {
    const guard = `if [ -z "$${FLUI_WEBHOOK_SECRET}" ]; then
            echo "::error::${FLUI_WEBHOOK_SECRET} is not set on this repository. Flui writes it as a repository secret just before it commits this workflow, so it was removed or never arrived. Re-generate the workflow from Flui to restore it. Not calling the webhook without a credential."
            exit 1
          fi`;

    return `
      - name: ${labels.success}
        if: success()
        continue-on-error: true
        env:
          ${FLUI_WEBHOOK_SECRET}: \${{ secrets.${FLUI_WEBHOOK_SECRET} }}
        run: |
          ${guard}
          SHORT_SHA=$(echo "\${{ github.sha }}" | cut -c1-7)
          if [[ "\${{ github.ref_type }}" == "tag" ]]; then
            VERSION=$(echo "\${{ github.ref_name }}" | sed 's/^v//')
            IMAGE_REF="\${{ env.IMAGE_NAME }}:$VERSION"
          else
            IMAGE_REF="\${{ env.IMAGE_NAME }}:$SHORT_SHA"
          fi
          PAYLOAD=$(printf '{"appId":"%s","imageRef":"%s","commitSha":"%s","branch":"%s","status":"success"}' \\
            "\${{ env.FLUI_APP_ID }}" "$IMAGE_REF" "\${{ github.sha }}" "\${{ github.ref_name }}")
          curl --fail -X POST ${webhookUrl} \\
            -H "Content-Type: application/json" \\
            -H "X-Flui-Token: $${FLUI_WEBHOOK_SECRET}" \\
            -d "$PAYLOAD"

      - name: ${labels.failure}
        if: failure()
        continue-on-error: true
        env:
          ${FLUI_WEBHOOK_SECRET}: \${{ secrets.${FLUI_WEBHOOK_SECRET} }}
        run: |
          ${guard}
          curl --fail -X POST ${webhookUrl} \\
            -H "Content-Type: application/json" \\
            -H "X-Flui-Token: $${FLUI_WEBHOOK_SECRET}" \\
            -d '{
              "appId": "\${{ env.FLUI_APP_ID }}",
              "commitSha": "\${{ github.sha }}",
              "branch": "\${{ github.ref_name }}",
              "status": "failed"
            }'`;
  }

  generateWorkflow(params: WorkflowParams): string {
    const fw = params.framework.toLowerCase().replaceAll('_', '-');
    const runtimeSetup = this.getRuntimeSetupStep(fw, params);
    const imageName = `ghcr.io/${params.githubUsername}/${params.repoName}`;

    // See generateWorkflowV3: BACKEND_POLLING_ONLY suppresses the webhook
    // notify steps and relies on the backend build watcher instead.
    const notifySteps = params.backendPollingOnly
      ? ''
      : this.notifyFluiSteps(params.fluiWebhookUrl, {
          success: 'Notify Flui on success',
          failure: 'Notify Flui on failure',
        });

    return `name: Flui Deploy

on:
  push:
    branches: [${params.branchName}]
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write
  packages: write

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${imageName}
  FLUI_APP_ID: ${params.fluiAppId}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
${runtimeSetup}
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.FLUI_GHCR_TOKEN || secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: \${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=sha,prefix=,format=short
            type=raw,value=latest,enable=\${{ github.ref == 'refs/heads/${params.branchName}' || startsWith(github.ref, 'refs/tags/v') }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
${notifySteps}
`;
  }

  generateDockerfile(params: DockerfileParams): string {
    const fw = params.framework.toLowerCase().replaceAll('_', '-');
    const nodeVersion = params.nodeVersion ?? '20';
    const javaVersion = params.javaVersion ?? '21';
    const dotnetVersion = params.dotnetVersion ?? '8.0';
    const port = params.port;
    const pm = params.packageManager ?? 'npm';
    let installCmd: string;
    if (pm === 'pnpm') installCmd = 'pnpm i --frozen-lockfile || pnpm i';
    else if (pm === 'yarn')
      installCmd = 'yarn install --frozen-lockfile || yarn install';
    else installCmd = 'npm ci || npm install';

    switch (fw) {
      case 'nextjs':
        return this.nextjsDockerfile({ nodeVersion, installCmd, pm, port });
      case 'nuxt':
        return this.nodeDockerfile({
          nodeVersion,
          installCmd,
          buildCmd: `${pm} run build`,
          outputDir: '.output',
          startCmd: 'node .output/server/index.mjs',
          port,
        });
      case 'svelte-kit':
        return this.nodeDockerfile({
          nodeVersion,
          installCmd,
          buildCmd: `${pm} run build`,
          outputDir: 'build',
          startCmd: 'node build/index.js',
          port,
        });
      case 'nestjs':
        return this.nestjsDockerfile({ nodeVersion, installCmd, pm, port });
      case 'angular':
        return this.angularDockerfile({
          nodeVersion,
          appName: params.appName ?? 'app',
          port,
        });
      case 'spring-boot':
        return this.springBootDockerfile({
          javaVersion,
          buildTool: params.buildTool ?? 'maven',
          port,
        });
      case 'django':
        return this.djangoDockerfile({ port });
      case 'fastapi':
        return this.fastapiDockerfile({ port });
      case 'aspnet-core':
        return this.aspnetDockerfile({
          dotnetVersion,
          appName: params.appName ?? 'App',
          port,
        });
      default:
        return this.nodeDockerfile({
          nodeVersion,
          installCmd,
          buildCmd: `${pm} run build`,
          outputDir: 'dist',
          startCmd: 'node dist/index.js',
          port,
        });
    }
  }

  // ─── Private runtime setup step generators ──────────────────────────────────

  private getRuntimeSetupStep(fw: string, params: WorkflowParams): string {
    if (
      [
        'nextjs',
        'nuxt',
        'svelte-kit',
        'angular',
        'nestjs',
        'express',
        'react-router',
        'remix',
      ].includes(fw)
    ) {
      return `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '${params.nodeVersion ?? '20'}'
`;
    }

    if (fw === 'spring-boot') {
      return `
      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          java-version: '${params.javaVersion ?? '21'}'
          distribution: 'temurin'
`;
    }

    if (fw === 'aspnet-core') {
      return `
      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '${params.dotnetVersion ?? '8.0'}'
`;
    }

    return '';
  }

  // ─── Dockerfile templates ────────────────────────────────────────────────────

  private nextjsDockerfile(p: {
    nodeVersion: string;
    installCmd: string;
    pm: string;
    port: number;
  }): string {
    return `FROM node:${p.nodeVersion}-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN ${p.installCmd}

FROM node:${p.nodeVersion}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ${p.pm} run build

FROM node:${p.nodeVersion}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE ${p.port}
CMD ["node_modules/.bin/next", "start"]
`;
  }

  private nodeDockerfile(p: {
    nodeVersion: string;
    installCmd: string;
    buildCmd: string;
    outputDir: string;
    startCmd: string;
    port: number;
  }): string {
    return `FROM node:${p.nodeVersion}-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN ${p.installCmd}

FROM node:${p.nodeVersion}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ${p.buildCmd}

FROM node:${p.nodeVersion}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/${p.outputDir} ./${p.outputDir}
COPY --from=builder /app/public ./public
EXPOSE ${p.port}
CMD ${JSON.stringify(p.startCmd.split(' '))}
`;
  }

  private nestjsDockerfile(p: {
    nodeVersion: string;
    installCmd: string;
    pm: string;
    port: number;
  }): string {
    return `FROM node:${p.nodeVersion}-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN ${p.installCmd}
COPY . .
RUN ${p.pm} run build

FROM node:${p.nodeVersion}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE ${p.port}
CMD ["node", "dist/main.js"]
`;
  }

  private angularDockerfile(p: {
    nodeVersion: string;
    appName: string;
    port: number;
  }): string {
    return `FROM node:${p.nodeVersion}-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runner
COPY --from=builder /app/dist/${p.appName}/browser /usr/share/nginx/html
EXPOSE ${p.port}
`;
  }

  private springBootDockerfile(p: {
    javaVersion: string;
    buildTool: 'maven' | 'gradle';
    port: number;
  }): string {
    const buildCmd =
      p.buildTool === 'gradle'
        ? './gradlew bootJar'
        : './mvnw package -DskipTests';
    const jarPath =
      p.buildTool === 'gradle' ? 'build/libs/*.jar' : 'target/*.jar';
    return `FROM eclipse-temurin:${p.javaVersion}-jdk-alpine AS builder
WORKDIR /app
COPY . .
RUN ${buildCmd}

FROM eclipse-temurin:${p.javaVersion}-jre-alpine AS runner
WORKDIR /app
COPY --from=builder /app/${jarPath} app.jar
EXPOSE ${p.port}
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
  }

  private djangoDockerfile(p: { port: number }): string {
    return `FROM python:3.12-slim AS runner
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${p.port}
CMD ["gunicorn", "app.wsgi:application", "--bind", "0.0.0.0:${p.port}"]
`;
  }

  private fastapiDockerfile(p: { port: number }): string {
    return `FROM python:3.12-slim AS runner
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${p.port}
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${p.port}"]
`;
  }

  private aspnetDockerfile(p: {
    dotnetVersion: string;
    appName: string;
    port: number;
  }): string {
    return `FROM mcr.microsoft.com/dotnet/sdk:${p.dotnetVersion} AS builder
WORKDIR /app
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o out

FROM mcr.microsoft.com/dotnet/aspnet:${p.dotnetVersion} AS runner
WORKDIR /app
COPY --from=builder /app/out .
EXPOSE ${p.port}
ENTRYPOINT ["dotnet", "${p.appName}.dll"]
`;
  }

  // ─── V3 Workflow (universal, Dockerfile-first) ──────────────────────────────

  /**
   * Generates a universal GitHub Actions workflow for V3 deployment.
   * No framework-specific steps — relies on the Dockerfile already in the repo.
   *
   * Image naming convention (opinionated, 1:1 with the git repo):
   *   single-app: ghcr.io/{owner}/{repoName}:{sha}
   *   monorepo:   ghcr.io/{owner}/{repoName}/{subPath}:{sha}
   *
   * Rationale: the package name maps deterministically to the git repo, so the
   * "use latest image" recovery (e.g. `flui deploy --no-build` after the app
   * was deleted from Flui) can look up the package on GHCR without needing
   * the original app slug.
   */
  generateWorkflowV3(params: WorkflowParamsV3): string {
    const repoSegment = params.repoName.toLowerCase();
    const subSegment = params.subPath ? `/${params.subPath.toLowerCase()}` : '';
    const imageName = `ghcr.io/${params.githubOwner.toLowerCase()}/${repoSegment}${subSegment}`;

    const buildContext = params.buildContext ?? '.';
    const dockerfileLine = params.dockerfilePath
      ? `\n          file: ${params.dockerfilePath}`
      : '';
    // `build.args` is a build-time value baked into the image — resolved
    // server-side from the manifest, the same way dockerfilePath/buildContext
    // already are, so it stays in lockstep with the rest of this generated
    // step rather than being parsed by the CI run itself.
    const buildArgLines = Object.entries(params.buildArgs ?? {}).map(
      ([k, v]) => `            ${k}=${v}`,
    );
    const buildArgsBlock = buildArgLines.length
      ? '\n          build-args: |\n' + buildArgLines.join('\n')
      : '';

    // Monorepo: scope the push trigger to this app's slice of the repo so a
    // push to a sibling app doesn't rebuild everything. The workflow file
    // itself is included so the very commit that adds it triggers the first
    // build. Note: GitHub ANDs `paths` with `tags` too — tag pushes only run
    // when the tagged commit touches these paths, which is the expected
    // behavior for per-app release tags in a monorepo.
    const pathsFilter =
      params.subPath && params.workflowFileName
        ? [
            `${params.subPath}/**`,
            ...(params.dockerfilePath &&
            !params.dockerfilePath.startsWith(`${params.subPath}/`)
              ? [params.dockerfilePath]
              : []),
            `.github/workflows/${params.workflowFileName}`,
          ]
        : null;
    const pathsBlock = pathsFilter
      ? `\n    paths:\n${pathsFilter.map((p) => `      - '${p}'`).join('\n')}`
      : '';

    // Keep the "Flui Deploy" prefix: webhook + watcher identify Flui runs by it.
    const workflowName = params.subPath
      ? `Flui Deploy (${params.appSlug})`
      : 'Flui Deploy';

    // When BACKEND_POLLING_ONLY is enabled, omit the Notify Flui steps
    // entirely — the backend watcher polls GitHub and discovers completion
    // on its own. Reduces workflow complexity and removes the webhook as a
    // failure mode.
    const notifySteps = params.backendPollingOnly
      ? ''
      : this.notifyFluiSteps(params.fluiWebhookUrl, {
          success: 'Notify Flui — success',
          failure: 'Notify Flui — failure',
        });

    return `name: ${workflowName}

on:
  push:
    branches: [${params.branchName}]
    tags: ['v*']${pathsBlock}
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${imageName}
  FLUI_APP_ID: ${params.fluiAppId}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.FLUI_GHCR_TOKEN || secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: \${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=sha,prefix=,format=short
            type=raw,value=latest
          labels: |
            org.opencontainers.image.source=https://github.com/\${{ github.repository }}
            org.opencontainers.image.revision=\${{ github.sha }}
          annotations: |
            org.opencontainers.image.source=https://github.com/\${{ github.repository }}
            org.opencontainers.image.revision=\${{ github.sha }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ${buildContext}${dockerfileLine}
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          annotations: \${{ steps.meta.outputs.annotations }}
          cache-from: type=gha
          cache-to: type=gha,mode=max${buildArgsBlock}
${notifySteps}
`;
  }
}
