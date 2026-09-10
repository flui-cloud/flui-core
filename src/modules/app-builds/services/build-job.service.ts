import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'node:https';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { AppBuildEntity } from '../entities/app-build.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { GitBuildSourceConfig } from '../../applications/interfaces/source-config.interface';
import { DeployStrategy } from '../../frameworks/framework-core/enums/deploy-strategy.enum';

export const BUILD_NAMESPACE = 'flui-build';
export const BUILD_RUNNER_IMAGE =
  'ghcr.io/dawit-io/flui-build-runner:railpack-0.22.2';
export const BUILD_CACHE_PVC_NAME = 'flui-buildkit-cache';

interface BuildJobInfo {
  name: string;
  status: 'Running' | 'Pending' | 'Succeeded' | 'Failed' | 'Unknown';
  ageSecs: number;
  buildId: string | null;
  appSlug: string | null;
  purpose: string | null;
  cpuRequestMillicores: number;
  memoryRequestMiB: number;
}

interface BuildPodInfo {
  name: string;
  phase: string;
  ageSecs: number;
  buildId: string | null;
  appSlug: string | null;
  containers: Array<{ name: string; ready: boolean; state: string }>;
}

/** Total CPU request (millicores) for a single build Job (git-clone + railpack + buildkitd) */
export const BUILD_JOB_CPU_REQUEST = 800;
/** Total memory request (Mi) for a single build Job */
export const BUILD_JOB_MEMORY_REQUEST = 896;

export interface BuildJobConfig {
  build: AppBuildEntity;
  app: ApplicationEntity;
  repoOwner: string;
  repoName: string;
  githubToken: string;
  imageRef: string;
  noCache?: boolean;
  cloneUrl?: string; // Public HTTPS clone URL; if set, git-clone skips token injection
  deployStrategy?: string; // DeployStrategy value from advisor
  suggestedBuildCommand?: string; // Used for railway.toml injection (RAILPACK_WITH_OVERRIDES)
  suggestedStartCommand?: string; // Used for railway.toml injection (RAILPACK_WITH_OVERRIDES)
  dockerfileContent?: string; // Used for DOCKERFILE strategy
}

@Injectable()
export class BuildJobService {
  private readonly logger = new Logger(BuildJobService.name);

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Ensure the flui-build namespace exists with the correct PSA labels.
   * Uses server-side apply so labels are always patched even if namespace already exists.
   */
  async ensureBuildNamespace(kubeconfig: string): Promise<void> {
    const manifest = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${BUILD_NAMESPACE}
  labels:
    managed-by: flui-cloud
    flui.cloud/tier: build
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/enforce-version: latest
`;
    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    this.logger.debug(`Namespace ${BUILD_NAMESPACE} ensured with PSA labels`);
  }

  /**
   * Create or update the ghcr-push-secret in the flui-build namespace.
   * Contains:
   *   - dockerconfig: Docker config.json for ghcr.io authentication
   *   - github_token: plaintext token for git clone via HTTPS
   */
  async ensureGhcrSecret(
    kubeconfig: string,
    githubUsername: string,
    githubToken: string,
  ): Promise<void> {
    const authBase64 = Buffer.from(`${githubUsername}:${githubToken}`).toString(
      'base64',
    );
    const dockerConfig = JSON.stringify({
      auths: {
        'ghcr.io': { auth: authBase64 },
      },
    });

    // Opaque secret — used as volume mount (dockerconfig key) and git clone token
    await this.kubernetesService.patchSecret(
      kubeconfig,
      BUILD_NAMESPACE,
      'ghcr-push-secret',
      {
        dockerconfig: dockerConfig,
        github_token: githubToken,
      },
    );

    // kubernetes.io/dockerconfigjson secret — used as imagePullSecret for the build runner image
    const dockerConfigJsonBase64 = Buffer.from(dockerConfig).toString('base64');
    const pullSecretManifest = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: ghcr-runner-pull-secret',
      `  namespace: ${BUILD_NAMESPACE}`,
      'type: kubernetes.io/dockerconfigjson',
      'data:',
      `  .dockerconfigjson: ${dockerConfigJsonBase64}`,
    ].join('\n');
    await this.kubernetesService.applyManifest(kubeconfig, pullSecretManifest);

    this.logger.log(
      `ghcr secrets updated in namespace ${BUILD_NAMESPACE} for user ${githubUsername}`,
    );
  }

  /**
   * Ensure the flui-buildkit-cache PVC exists in the flui-build namespace.
   * Mounts at /var/lib/buildkit in the buildkitd container to persist BuildKit's
   * content-addressable store across Jobs. This covers all package manager caches
   * (pnpm, NuGet, Maven, Gradle, pip, etc.) via railpack's RUN --mount=type=cache directives.
   */
  async ensureBuildCachePvc(kubeconfig: string): Promise<void> {
    const storage = this.configService.get<string>(
      'BUILD_CACHE_PVC_STORAGE',
      '20Gi',
    );
    const storageClass = this.configService.get<string>(
      'BUILD_CACHE_STORAGE_CLASS',
      'local-path',
    );
    const manifest = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${BUILD_CACHE_PVC_NAME}
  namespace: ${BUILD_NAMESPACE}
  labels:
    managed-by: flui-cloud
    flui.cloud/purpose: buildkit-cache
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: ${storage}
`;
    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    this.logger.debug(
      `BuildKit cache PVC ${BUILD_CACHE_PVC_NAME} ensured (${storage}, ${storageClass})`,
    );
  }

  /**
   * Delete the flui-buildkit-cache PVC. Used by cache-clear operations.
   * Deletion is permanent — the underlying volume data is wiped.
   */
  async deleteBuildCachePvc(kubeconfig: string): Promise<void> {
    await this.kubernetesService.deleteResource(
      kubeconfig,
      'PersistentVolumeClaim',
      BUILD_CACHE_PVC_NAME,
      BUILD_NAMESPACE,
    );
    this.logger.log(`BuildKit cache PVC ${BUILD_CACHE_PVC_NAME} deleted`);
  }

  /**
   * Return metadata about the flui-buildkit-cache PVC from the Kubernetes API.
   * Returns null if the PVC does not exist.
   */
  async getBuildCachePvcInfo(kubeconfig: string): Promise<{
    exists: boolean;
    phase: string | null;
    capacity: string | null;
    storageClass: string | null;
    createdAt: Date | null;
  }> {
    const pvc = await this.kubernetesService.getResource(
      kubeconfig,
      'PersistentVolumeClaim',
      BUILD_CACHE_PVC_NAME,
      BUILD_NAMESPACE,
    );
    if (!pvc) {
      return {
        exists: false,
        phase: null,
        capacity: null,
        storageClass: null,
        createdAt: null,
      };
    }
    return {
      exists: true,
      phase: pvc.status?.phase ?? null,
      capacity:
        pvc.status?.capacity?.storage ??
        pvc.spec?.resources?.requests?.storage ??
        null,
      storageClass: pvc.spec?.storageClassName ?? null,
      createdAt: pvc.metadata?.creationTimestamp
        ? new Date(pvc.metadata.creationTimestamp)
        : null,
    };
  }

  /**
   * Build the image reference for the build.
   * Format: ghcr.io/{githubUsername}/{appName}:{branch}-{shortSha}
   * appName is derived from appSlug stripping any trailing branch/random suffix
   * so the ghcr.io package name stays stable across branches and rebuilds.
   */
  buildImageRef(
    githubUsername: string,
    appSlug: string,
    commitSha?: string,
    branch?: string,
    suffix?: string,
  ): string {
    const shortSha = commitSha
      ? commitSha.substring(0, 8)
      : Date.now().toString(36);
    const safeBranch = (branch ?? 'main')
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-');
    return `ghcr.io/${githubUsername}/${appSlug}:${safeBranch}-${shortSha}${suffix ?? ''}`;
  }

  /**
   * Generate a DNS-safe K8s Job name from the app slug and commit SHA.
   * Ensures max 63 chars (K8s name limit).
   */
  buildJobName(appSlug: string, commitSha?: string, suffix?: string): string {
    const shortSha = commitSha
      ? commitSha.substring(0, 8)
      : Date.now().toString(36);
    const base = `flui-build-${appSlug}-${shortSha}${suffix ?? ''}`;
    return base
      .substring(0, 63)
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-');
  }

  /**
   * Apply the K3s build Job manifest to the cluster.
   * Returns the job name applied.
   */
  async createBuildJob(
    kubeconfig: string,
    config: BuildJobConfig,
  ): Promise<string> {
    const { build, app, repoOwner, repoName, imageRef, noCache } = config;
    const sourceConfig = app.sourceConfig as GitBuildSourceConfig;
    const branch = sourceConfig?.branch || build.branch;
    const noCacheFlag = noCache ? '\\\n                --no-cache' : '';

    const strategy = config.deployStrategy ?? DeployStrategy.RAILPACK_DIRECT;
    const useDockerfile = strategy === DeployStrategy.DOCKERFILE;
    const useOverrides = strategy === DeployStrategy.RAILPACK_WITH_OVERRIDES;

    // ── Strategy-specific script sections ──────────────────────────────────
    // RAILPACK_WITH_OVERRIDES: write railway.toml before railpack prepare
    const railwayTomlInjection = (() => {
      if (!useOverrides) return '';
      const buildCmd = config.suggestedBuildCommand;
      const startCmd = config.suggestedStartCommand;
      if (!buildCmd && !startCmd) return '';
      const lines: string[] = [
        "cat > /workspace/railway.toml <<'TOML_EOF'",
        '[build]',
      ];
      if (buildCmd) lines.push(`buildCommand = "${buildCmd}"`);
      lines.push('[deploy]');
      if (startCmd) lines.push(`startCommand = "${startCmd}"`);
      lines.push(
        'TOML_EOF',
        'echo "FLUI-RUNNER: railway.toml injected (strategy=railpack_with_overrides)"',
      );
      return '\n              ' + lines.join('\n              ') + '\n';
    })();

    // DOCKERFILE strategy: write dockerfile content to workspace
    const dockerfileWriteStep = (() => {
      if (!useDockerfile) return '';
      const content = config.dockerfileContent ?? '';
      if (!content) return '';
      // Use printf to avoid heredoc quoting issues with arbitrary Dockerfile content
      const escaped = content
        .replaceAll('\\', String.raw`\\`)
        .replaceAll('%', '%%')
        .replaceAll("'", String.raw`'\''`)
        .replaceAll('\r', '')
        .replaceAll('\n', String.raw`\n`);
      return `\n              printf '${escaped}' > /workspace/Dockerfile\n              echo "FLUI-RUNNER: Dockerfile written from build advisor (strategy=dockerfile)"\n`;
    })();

    // Build frontend selection: dockerfile.v0 for DOCKERFILE, gateway.v0 (Railpack) otherwise
    const buildFrontendArgs = useDockerfile
      ? String.raw`--frontend dockerfile.v0 \
                --local context=/workspace \
                --local dockerfile=/workspace`
      : String.raw`--frontend gateway.v0 \
                --opt source=ghcr.io/railwayapp/railpack-frontend \
                --opt filename=railpack-plan.json \
                --local context=/workspace \
                --local dockerfile=/tmp`;

    // Railpack plan step is only needed for non-DOCKERFILE strategies
    const railpackPlanStep = useDockerfile
      ? ''
      : [
          '',
          '              echo "--- RAILPACK PLAN ---"',
          '              railpack prepare . --plan-out /tmp/railpack-plan.json',
          '              if [ -f /tmp/railpack-plan.json ]; then',
          String.raw`                tr -d '\n\r' < /tmp/railpack-plan.json && echo ""`,
          '              fi',
          '',
          '              # Fix railpack start command for single-project Gradle builds.',
          String.raw`              if grep -q '\*/build/libs/' /tmp/railpack-plan.json 2>/dev/null; then`,
          '                IS_MULTI_PROJECT=0',
          "                if grep -qE '^[[:space:]]*include[[:space:]]*\\(' /workspace/settings.gradle 2>/dev/null || \\",
          "                   grep -qE '^[[:space:]]*include[[:space:]]*\\(' /workspace/settings.gradle.kts 2>/dev/null; then",
          '                  IS_MULTI_PROJECT=1',
          '                fi',
          '                if [ "$IS_MULTI_PROJECT" -eq 0 ]; then',
          '                  echo "FLUI-RUNNER: Single-project Gradle — fixing */build/libs/ in railpack plan"',
          String.raw`                  sed -i 's|\*/build/libs/|build/libs/|g' /tmp/railpack-plan.json`,
          '                  echo "FLUI-RUNNER: Plan patched"',
          '                else',
          '                  echo "FLUI-RUNNER: Multi-project Gradle — keeping */build/libs/ glob as-is"',
          '                fi',
          '              fi',
        ].join('\n');

    // For public repos, clone using the plain URL (no token). For private repos, inject token.
    const gitCloneTarget = config.cloneUrl
      ? `"${config.cloneUrl}"`
      : `"https://x-oauth-basic:$(GITHUB_TOKEN)@github.com/${repoOwner}/${repoName}.git"`;
    const gitCloneEnv = config.cloneUrl
      ? ''
      : `
          env:
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ghcr-push-secret
                  key: github_token`;

    const usePrivileged =
      this.configService.get<string>('BUILDKIT_PRIVILEGED_MODE', 'true') ===
      'true';

    const buildkitSecurityContext = usePrivileged
      ? `
          securityContext:
            privileged: true`
      : `
          securityContext:
            seccompProfile:
              type: Unconfined
            runAsUser: 1000
            runAsGroup: 1000`;

    const buildkitImage = usePrivileged
      ? 'moby/buildkit:v0.15.1'
      : 'moby/buildkit:v0.15.1-rootless';

    const manifest = String.raw`
apiVersion: batch/v1
kind: Job
metadata:
  name: ${build.k8sJobName}
  namespace: ${BUILD_NAMESPACE}
  labels:
    app.kubernetes.io/managed-by: flui-cloud
    flui.cloud/build-id: "${build.id}"
    flui.cloud/app-id: "${app.id}"
    flui.cloud/app-slug: "${app.slug}"
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 0
  activeDeadlineSeconds: 1800
  template:
    metadata:
      labels:
        flui.cloud/build-id: "${build.id}"
        flui.cloud/app-slug: "${app.slug}"
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: ghcr-runner-pull-secret
      initContainers:
        - name: git-clone
          image: alpine/git:2.43.0
          command:
            - sh
            - -c
            - |
              git clone --depth=1 --branch "${branch}" \\
                ${gitCloneTarget} \\
                /workspace && \\
              cd /workspace && \\
              git log -1 --format="%H" > /workspace/.commit-sha && \\
              echo "Clone complete: $(cat /workspace/.commit-sha)"${gitCloneEnv}
          volumeMounts:
            - name: workspace
              mountPath: /workspace
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
      containers:
        - name: build
          image: ${BUILD_RUNNER_IMAGE}
          imagePullPolicy: IfNotPresent
          command:
            - sh
            - -c
            - |
              set -e

              echo "Railpack: $(railpack --version)"
              echo "buildctl: $(buildctl --version)"
              echo "FLUI-RUNNER: build script v2 (Foojay enabled)"

              cd /workspace

              # Output actual commit SHA cloned by init container (used for build deduplication)
              ACTUAL_SHA=$(cat /workspace/.commit-sha 2>/dev/null | tr -d '[:space:]')
              if [ -n "$ACTUAL_SHA" ]; then echo "COMMIT_SHA=$ACTUAL_SHA"; fi

              # If the project declares a Gradle Java toolchain version, pin that version
              # via .tool-versions so railpack/mise installs the exact JDK Gradle needs.
              GRADLE_TOOLCHAIN_VERSION=$(grep -rE 'JavaLanguageVersion\\.of\\(' /workspace/build.gradle /workspace/build.gradle.kts 2>/dev/null | grep -oE 'of\\([0-9]+\\)' | grep -oE '[0-9]+' | sort -n | head -1)
              if [ -n "$GRADLE_TOOLCHAIN_VERSION" ]; then
                echo "FLUI-RUNNER: Gradle toolchain requires Java $GRADLE_TOOLCHAIN_VERSION — pinning via .tool-versions"
                echo "java $GRADLE_TOOLCHAIN_VERSION" >> /workspace/.tool-versions
                echo "FLUI-RUNNER: .tool-versions updated: $(cat /workspace/.tool-versions | grep java)"
              else
                echo "FLUI-RUNNER: No Gradle toolchain declaration found, using railpack default"
              fi

${railwayTomlInjection}${dockerfileWriteStep}${railpackPlanStep}

              echo "--- RAILPACK BUILD ---"
              buildctl \\
                --addr unix:///run/buildkit/buildkitd.sock \\
                build${noCacheFlag} \\
                ${buildFrontendArgs} \\
                --output "type=image,name=${imageRef},push=true"

              echo "--- BUILD COMPLETE ---"
              echo "IMAGE_REF=${imageRef}"
          env:
            - name: DOCKER_CONFIG
              value: /root/.docker
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: buildkit-socket
              mountPath: /run/buildkit
            - name: docker-config
              mountPath: /root/.docker
              readOnly: true
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
        - name: buildkitd
          image: ${buildkitImage}
          args:
            - --addr
            - unix:///run/buildkit/buildkitd.sock
${buildkitSecurityContext}
          volumeMounts:
            - name: buildkit-socket
              mountPath: /run/buildkit
            - name: buildkit-cache
              mountPath: /var/lib/buildkit
          readinessProbe:
            exec:
              command:
                - buildctl
                - debug
                - workers
            initialDelaySeconds: 5
            periodSeconds: 3
            failureThreshold: 10
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
      volumes:
        - name: workspace
          emptyDir: {}
        - name: buildkit-socket
          emptyDir: {}
        - name: docker-config
          secret:
            secretName: ghcr-push-secret
            items:
              - key: dockerconfig
                path: config.json
        - name: buildkit-cache
          persistentVolumeClaim:
            claimName: ${BUILD_CACHE_PVC_NAME}
`;

    // K8s Job spec.template is immutable — patching an existing job silently
    // ignores command changes. Always delete the old job first so the new
    // script takes effect.
    await this.deleteJob(kubeconfig, build.k8sJobName);

    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    this.logger.log(
      `Build Job ${build.k8sJobName} created in namespace ${BUILD_NAMESPACE}`,
    );

    return build.k8sJobName;
  }

  /**
   * Ensure the build runner image exists in ghcr.io.
   * If missing, bootstrap it by running a K8s Job that builds and pushes the image
   * using the same BuildKit infrastructure used for app builds.
   */
  async ensureBuildRunnerImage(
    kubeconfig: string,
    githubUsername: string,
    githubToken: string,
  ): Promise<void> {
    const exists = await this.checkBuildRunnerExists(
      githubUsername,
      githubToken,
    );
    if (exists) {
      this.logger.debug(
        `Build runner image ${BUILD_RUNNER_IMAGE} found — skipping bootstrap`,
      );
      return;
    }
    this.logger.log(
      `Build runner image ${BUILD_RUNNER_IMAGE} not found — starting bootstrap build`,
    );
    await this.bootstrapBuildRunnerImage(kubeconfig);
    this.logger.log(`Build runner image ${BUILD_RUNNER_IMAGE} ready`);
  }

  /**
   * Check if the build runner image exists in the ghcr.io registry.
   * Uses the Docker Distribution API v2 with the user's GitHub token.
   */
  private async checkBuildRunnerExists(
    githubUsername: string,
    githubToken: string,
  ): Promise<boolean> {
    const authBase64 = Buffer.from(`${githubUsername}:${githubToken}`).toString(
      'base64',
    );
    try {
      const tokenPayload = await this.httpsGetJson(
        'https://ghcr.io/token?scope=repository:dawit-io/flui-build-runner:pull&service=ghcr.io',
        `Basic ${authBase64}`,
      );
      const registryToken: string =
        tokenPayload?.token ?? tokenPayload?.access_token;
      if (!registryToken) {
        this.logger.warn(
          'Could not obtain ghcr.io registry token for build runner check',
        );
        return false;
      }
      const status = await this.httpsHeadStatus(
        'https://ghcr.io/v2/dawit-io/flui-build-runner/manifests/railpack-0.22.2',
        `Bearer ${registryToken}`,
      );
      this.logger.debug(`Build runner manifest check: HTTP ${status}`);
      return status === 200;
    } catch (err) {
      this.logger.warn(
        `Build runner image check failed: ${err.message} — will bootstrap`,
      );
      return false;
    }
  }

  /**
   * Build and push the build runner image by running a one-off K8s Job.
   * The Job writes the Dockerfile from an embedded template, then uses
   * BuildKit (already available in the cluster) to build and push it.
   */
  private async bootstrapBuildRunnerImage(kubeconfig: string): Promise<void> {
    const jobName = `flui-bootstrap-runner-${Date.now().toString(36)}`;

    const dockerfile = [
      'FROM debian:12-slim',
      'ARG RAILPACK_VERSION=0.22.2',
      'ARG BUILDKIT_VERSION=0.15.1',
      'RUN apt-get update -qq \\',
      '    && apt-get install -y -qq --no-install-recommends curl ca-certificates \\',
      '    && rm -rf /var/lib/apt/lists/*',
      'RUN curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \\',
      '    | tar xz -C /usr/local/bin railpack \\',
      '    && chmod +x /usr/local/bin/railpack',
      'RUN curl -fsSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-amd64.tar.gz" \\',
      '    | tar xz -C /usr/local/bin --strip-components=1 bin/buildctl \\',
      '    && chmod +x /usr/local/bin/buildctl',
      'RUN railpack --version && buildctl --version',
    ].join('\n');

    const dockerfileBase64 = Buffer.from(dockerfile).toString('base64');

    const usePrivileged =
      this.configService.get<string>('BUILDKIT_PRIVILEGED_MODE', 'true') ===
      'true';
    const buildkitSecurityContext = usePrivileged
      ? `
          securityContext:
            privileged: true`
      : `
          securityContext:
            seccompProfile:
              type: Unconfined
            runAsUser: 1000
            runAsGroup: 1000`;

    const manifest = String.raw`
apiVersion: batch/v1
kind: Job
metadata:
  name: ${jobName}
  namespace: ${BUILD_NAMESPACE}
  labels:
    app.kubernetes.io/managed-by: flui-cloud
    flui.cloud/purpose: bootstrap-runner
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 0
  activeDeadlineSeconds: 900
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: ghcr-runner-pull-secret
      initContainers:
        - name: write-dockerfile
          image: alpine:3.19
          command:
            - sh
            - -c
            - |
              echo '${dockerfileBase64}' | base64 -d > /workspace/Dockerfile
              echo "Dockerfile written."
          volumeMounts:
            - name: workspace
              mountPath: /workspace
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
      containers:
        - name: bootstrap
          image: moby/buildkit:v0.15.1
          command:
            - sh
            - -c
            - |
              echo "Waiting for buildkitd..."
              until /usr/bin/buildctl --addr unix:///run/buildkit/buildkitd.sock debug workers > /dev/null 2>&1; do
                sleep 2
              done
              echo "Building ${BUILD_RUNNER_IMAGE}..."
              /usr/bin/buildctl \\
                --addr unix:///run/buildkit/buildkitd.sock \\
                build \\
                --frontend dockerfile.v0 \\
                --local context=/workspace \\
                --local dockerfile=/workspace \\
                --output "type=image,name=${BUILD_RUNNER_IMAGE},push=true"
              echo "Bootstrap complete."
          env:
            - name: DOCKER_CONFIG
              value: /root/.docker
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: buildkit-socket
              mountPath: /run/buildkit
            - name: docker-config
              mountPath: /root/.docker
              readOnly: true
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
        - name: buildkitd
          image: moby/buildkit:v0.15.1
          args:
            - --addr
            - unix:///run/buildkit/buildkitd.sock
${buildkitSecurityContext}
          volumeMounts:
            - name: buildkit-socket
              mountPath: /run/buildkit
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
      volumes:
        - name: workspace
          emptyDir: {}
        - name: buildkit-socket
          emptyDir: {}
        - name: docker-config
          secret:
            secretName: ghcr-push-secret
            items:
              - key: dockerconfig
                path: config.json
`;
    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    this.logger.log(
      `Bootstrap job ${jobName} created — building ${BUILD_RUNNER_IMAGE}`,
    );

    await this.waitForJobCompletion(kubeconfig, jobName, 900_000);

    try {
      await this.kubernetesService.deleteResource(
        kubeconfig,
        'Job',
        jobName,
        BUILD_NAMESPACE,
      );
    } catch {
      /* non-fatal */
    }
  }

  private httpsGetJson(url: string, authorization: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        url,
        { headers: { Authorization: authorization } },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(
                new Error(
                  `Non-JSON response from ${url}: ${data.substring(0, 100)}`,
                ),
              );
            }
          });
        },
      );
      req.on('error', reject);
    });
  }

  private httpsHeadStatus(url: string, authorization: string): Promise<number> {
    const parsed = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'HEAD',
          headers: {
            Authorization: authorization,
            Accept:
              'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json',
          },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Delete a K3s Job and its pods (best-effort cleanup on failure).
   */
  async deleteJob(
    kubeconfig: string,
    jobName: string,
    buildId?: string,
  ): Promise<void> {
    try {
      await this.kubernetesService.deleteResource(
        kubeconfig,
        'Job',
        jobName,
        BUILD_NAMESPACE,
      );
      this.logger.log(`Build Job ${jobName} deleted from ${BUILD_NAMESPACE}`);
    } catch (error) {
      this.logger.warn(
        `Failed to delete build Job ${jobName}: ${error.message}`,
      );
    }

    // Explicitly delete pods — cascade delete is not guaranteed without propagationPolicy
    if (buildId) {
      try {
        const { coreApi } = this.kubernetesService.getKubeClient(kubeconfig);
        await coreApi.deleteCollectionNamespacedPod({
          namespace: BUILD_NAMESPACE,
          labelSelector: `flui.cloud/build-id=${buildId}`,
        });
        this.logger.log(
          `Deleted pods for build ${buildId} from ${BUILD_NAMESPACE}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to delete pods for build ${buildId}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Poll until the build Job pod transitions to Running.
   * Streams K8s Events for the pod to onStatusLine so the frontend receives
   * live feedback (image pulls, container creation, etc.) during Pending.
   * Returns the pod name once running.
   */
  async waitForPodRunning(
    kubeconfig: string,
    buildId: string,
    timeoutMs = 600_000,
    onStatusLine?: (line: string) => void,
  ): Promise<string> {
    const { coreApi } = this.kubernetesService.getKubeClient(kubeconfig);
    const deadline = Date.now() + timeoutMs;
    const labelSelector = `flui.cloud/build-id=${buildId}`;
    const seenEventUids = new Set<string>();
    let podName: string | undefined;

    while (Date.now() < deadline) {
      // ── 1. Find the pod (any phase) ────────────────────────────────────────
      const pods = await coreApi.listNamespacedPod({
        namespace: BUILD_NAMESPACE,
        labelSelector,
      });

      const pod = (pods.items ?? [])[0];

      if (!pod) {
        onStatusLine?.('Waiting for build pod to be scheduled...');
        await this.sleep(3000);
        continue;
      }

      podName = pod.metadata?.name;

      // ── 2. Fail fast on unrecoverable container states ────────────────────
      const allContainerStatuses = [
        ...(pod.status?.initContainerStatuses ?? []),
        ...(pod.status?.containerStatuses ?? []),
      ];
      const FATAL_REASONS = new Set([
        'ImagePullBackOff',
        'ErrImagePull',
        'InvalidImageName',
        'ImageInspectError',
      ]);
      for (const cs of allContainerStatuses) {
        const waitingReason = cs.state?.waiting?.reason;
        if (waitingReason && FATAL_REASONS.has(waitingReason)) {
          const msg = `Container "${cs.name}" failed to start: ${cs.state.waiting.message ?? waitingReason}`;
          onStatusLine?.(msg);
          throw new Error(msg);
        }
      }

      // Fail fast on unschedulable (after 30s grace period)
      const unschedulable = pod.status?.conditions?.find(
        (c) =>
          c.type === 'PodScheduled' &&
          c.status === 'False' &&
          c.reason === 'Unschedulable',
      );
      if (unschedulable && Date.now() > deadline - timeoutMs + 30_000) {
        const msg = `Pod unschedulable: ${unschedulable.message ?? 'insufficient resources'}`;
        onStatusLine?.(msg);
        throw new Error(msg);
      }

      // ── 3. Stream K8s Events for this pod (dedup by uid) ──────────────────
      if (podName) {
        try {
          const events = await coreApi.listNamespacedEvent({
            namespace: BUILD_NAMESPACE,
            fieldSelector: `involvedObject.name=${podName}`,
          });
          for (const ev of events.items ?? []) {
            const uid = ev.metadata?.uid;
            if (uid && !seenEventUids.has(uid) && ev.message) {
              seenEventUids.add(uid);
              onStatusLine?.(ev.message);
              this.logger.debug(`[pod-event] ${ev.message}`);
            }
          }
        } catch {
          // RBAC or transient error — non-fatal, skip events this tick
        }
      }

      // ── 4. Check phase ─────────────────────────────────────────────────────
      const phase = pod.status?.phase;

      if (phase === 'Failed') {
        // Check initContainers first (e.g. git-clone failure), then regular containers
        const failedInit = pod.status?.initContainerStatuses?.find(
          (cs) => cs.state?.terminated?.exitCode !== 0,
        );
        const failedContainer = pod.status?.containerStatuses?.find(
          (cs) => cs.state?.terminated?.exitCode !== 0,
        );
        const failed = failedInit ?? failedContainer;
        const containerName = failed?.name ?? 'unknown';
        const exitCode = failed?.state?.terminated?.exitCode;

        // Read container logs before pod gets deleted — this is the actual error (e.g. git stderr)
        let containerLogs = '';
        if (podName) {
          try {
            const logsResp = await coreApi.readNamespacedPodLog({
              name: podName,
              namespace: BUILD_NAMESPACE,
              container: containerName,
              tailLines: 20,
            });
            containerLogs =
              typeof logsResp === 'string'
                ? logsResp.trim()
                : ((logsResp as any)?.body?.trim() ?? '');
          } catch {
            // non-fatal — pod may already be terminating
          }
        }

        const fallbackMessage =
          failed?.state?.terminated?.message ??
          failed?.state?.terminated?.reason ??
          pod.status?.message ??
          'Unknown reason';
        const errorDetail = containerLogs || fallbackMessage;
        throw new Error(
          `Build pod failed: container "${containerName}" exited with code ${exitCode ?? '?'}: ${errorDetail}`,
        );
      }

      if (phase === 'Running' || phase === 'Succeeded') {
        this.logger.log(`Build pod ${podName} is ${phase}`);
        return podName;
      }

      await this.sleep(3000);
    }

    throw new Error(`Timeout waiting for build pod to start (${timeoutMs}ms)`);
  }

  /**
   * Poll the Job status until it succeeds or fails.
   * Returns true on success, throws on failure.
   */
  async waitForJobCompletion(
    kubeconfig: string,
    jobName: string,
    timeoutMs = 1800000, // 30 minutes
  ): Promise<void> {
    const { batchApi } = this.kubernetesService.getKubeClient(kubeconfig);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await batchApi.readNamespacedJob({
        name: jobName,
        namespace: BUILD_NAMESPACE,
      });

      const status = job.status;

      if (status?.succeeded > 0) {
        this.logger.log(`Build Job ${jobName} completed successfully`);
        return;
      }

      if (status?.failed > 0) {
        throw new Error(
          `Build Job ${jobName} failed (attempts: ${status.failed})`,
        );
      }

      await this.sleep(5000);
    }

    throw new Error(
      `Timeout waiting for build Job ${jobName} to complete (${timeoutMs}ms)`,
    );
  }

  // ─── Namespace resource inspection & cleanup ────────────────────────────────

  /**
   * List all Jobs and Pods in the flui-build namespace with status, age, and labels.
   *
   * Tolerates a missing namespace (returns empty lists) so that callers can
   * safely query diagnostic endpoints on clusters where the in-cluster build
   * agent has never run — e.g. when the master switch is disabled.
   */
  async getNamespaceResources(kubeconfig: string): Promise<{
    jobs: BuildJobInfo[];
    pods: BuildPodInfo[];
  }> {
    const { coreApi, batchApi } =
      this.kubernetesService.getKubeClient(kubeconfig);

    try {
      const [jobsRes, podsRes] = await Promise.all([
        batchApi.listNamespacedJob({ namespace: BUILD_NAMESPACE }),
        coreApi.listNamespacedPod({ namespace: BUILD_NAMESPACE }),
      ]);

      const jobs: BuildJobInfo[] = (jobsRes.items ?? []).map((job) => {
        const containers = job.spec?.template?.spec?.containers ?? [];
        return {
          name: job.metadata?.name ?? '',
          status: this.deriveJobStatus(job),
          ageSecs: this.ageSeconds(job.metadata?.creationTimestamp),
          buildId: job.metadata?.labels?.['flui.cloud/build-id'] ?? null,
          appSlug: job.metadata?.labels?.['flui.cloud/app-slug'] ?? null,
          purpose: job.metadata?.labels?.['flui.cloud/purpose'] ?? null,
          cpuRequestMillicores: containers.reduce(
            (sum, c) =>
              sum + this.parseCpuMillicores(c.resources?.requests?.['cpu']),
            0,
          ),
          memoryRequestMiB: containers.reduce(
            (sum, c) =>
              sum + this.parseMemoryMiB(c.resources?.requests?.['memory']),
            0,
          ),
        };
      });

      const pods: BuildPodInfo[] = (podsRes.items ?? []).map((pod) => ({
        name: pod.metadata?.name ?? '',
        phase: pod.status?.phase ?? 'Unknown',
        ageSecs: this.ageSeconds(pod.metadata?.creationTimestamp),
        buildId: pod.metadata?.labels?.['flui.cloud/build-id'] ?? null,
        appSlug: pod.metadata?.labels?.['flui.cloud/app-slug'] ?? null,
        containers: [
          ...(pod.status?.initContainerStatuses ?? []),
          ...(pod.status?.containerStatuses ?? []),
        ].map((cs: any) => ({
          name: cs.name,
          ready: cs.ready ?? false,
          state: this.deriveContainerState(cs),
        })),
      }));

      return { jobs, pods };
    } catch (err: any) {
      if (this.isNamespaceNotFoundError(err)) {
        return { jobs: [], pods: [] };
      }
      throw err;
    }
  }

  /**
   * Returns true if the error came from the Kubernetes API indicating that
   * the target namespace (or a resource within it) does not exist.
   * Handles both the new `@kubernetes/client-node` v1 error shape
   * (`ApiException` with `.code`) and the legacy `.response.statusCode` shape.
   */
  private isNamespaceNotFoundError(err: any): boolean {
    if (!err) return false;
    const code: number | undefined =
      err.code ?? err.statusCode ?? err.response?.statusCode;
    if (code === 404) return true;
    const reason =
      err.body?.reason ??
      err.response?.body?.reason ??
      (typeof err.body === 'string' ? undefined : err.body?.reason);
    return reason === 'NotFound';
  }

  /**
   * Delete stale Jobs and orphaned Pods from the flui-build namespace.
   * Stale = build is in a terminal DB state, or the resource is in a K8s terminal state.
   * @param activeBuilds Set of build IDs that are currently in-progress (should NOT be deleted).
   * @param olderThanMinutes If > 0, skip resources younger than this threshold.
   * @param dryRun If true, return what would be deleted without making changes.
   */
  async cleanupStaleResources(
    kubeconfig: string,
    activeBuilds: Set<string>,
    olderThanMinutes: number,
    dryRun: boolean,
  ): Promise<{ deletedJobs: string[]; deletedPods: string[] }> {
    const { coreApi } = this.kubernetesService.getKubeClient(kubeconfig);
    const { jobs, pods } = await this.getNamespaceResources(kubeconfig);
    const minAgeSecs = olderThanMinutes * 60;

    const deletedJobs: string[] = [];
    const deletedPods: string[] = [];

    for (const job of jobs) {
      if (!this.isJobStale(job, activeBuilds, minAgeSecs)) continue;
      deletedJobs.push(job.name);
      if (!dryRun) {
        await this.kubernetesService
          .deleteResource(kubeconfig, 'Job', job.name, BUILD_NAMESPACE)
          .catch((e) =>
            this.logger.warn(
              `Cleanup: failed to delete Job ${job.name}: ${e.message}`,
            ),
          );
      }
    }

    for (const pod of pods) {
      if (!this.isPodStale(pod, activeBuilds, minAgeSecs)) continue;
      deletedPods.push(pod.name);
      if (!dryRun) {
        await coreApi
          .deleteNamespacedPod({ name: pod.name, namespace: BUILD_NAMESPACE })
          .catch((e) =>
            this.logger.warn(
              `Cleanup: failed to delete Pod ${pod.name}: ${e.message}`,
            ),
          );
      }
    }

    this.logger.log(
      `Namespace cleanup${dryRun ? ' (dry-run)' : ''}: ` +
        `${deletedJobs.length} jobs, ${deletedPods.length} pods`,
    );

    return { deletedJobs, deletedPods };
  }

  private isJobStale(
    job: BuildJobInfo,
    activeBuilds: Set<string>,
    minAgeSecs: number,
  ): boolean {
    if (minAgeSecs > 0 && job.ageSecs < minAgeSecs) return false;
    // Bootstrap jobs: stale when not Running
    if (job.purpose === 'bootstrap-runner') {
      return job.status !== 'Running' && job.status !== 'Pending';
    }
    // App build jobs: stale when build is not in active state
    if (job.buildId) {
      return !activeBuilds.has(job.buildId);
    }
    // Any other terminal job
    return job.status === 'Succeeded' || job.status === 'Failed';
  }

  private isPodStale(
    pod: BuildPodInfo,
    activeBuilds: Set<string>,
    minAgeSecs: number,
  ): boolean {
    const errorPhases = ['Failed', 'Unknown'];
    const errorContainerStates = new Set([
      'OOMKilled',
      'Error',
      'CrashLoopBackOff',
      'ImagePullBackOff',
    ]);
    // Always stale regardless of age if in an error state
    const hasErrorContainer = pod.containers.some((c) =>
      errorContainerStates.has(c.state),
    );
    if (errorPhases.includes(pod.phase) || hasErrorContainer) return true;
    if (minAgeSecs > 0 && pod.ageSecs < minAgeSecs) return false;
    if (pod.buildId) return !activeBuilds.has(pod.buildId);
    return pod.phase === 'Succeeded';
  }

  private deriveJobStatus(job: any): BuildJobInfo['status'] {
    if ((job.status?.active ?? 0) > 0) return 'Running';
    if ((job.status?.succeeded ?? 0) > 0) return 'Succeeded';
    if ((job.status?.failed ?? 0) > 0) return 'Failed';
    if (job.status?.startTime) return 'Pending';
    return 'Unknown';
  }

  private deriveContainerState(cs: any): string {
    if (cs.state?.running) return 'Running';
    if (cs.state?.terminated) return cs.state.terminated.reason ?? 'Terminated';
    if (cs.state?.waiting) return cs.state.waiting.reason ?? 'Waiting';
    return 'Unknown';
  }

  private ageSeconds(creationTimestamp: Date | string | undefined): number {
    if (!creationTimestamp) return 0;
    return Math.floor(
      (Date.now() - new Date(creationTimestamp).getTime()) / 1000,
    );
  }

  private parseCpuMillicores(cpu: string | undefined): number {
    if (!cpu) return 0;
    if (cpu.endsWith('m')) return Number.parseInt(cpu.slice(0, -1), 10);
    return Math.round(Number.parseFloat(cpu) * 1000);
  }

  private parseMemoryMiB(memory: string | undefined): number {
    if (!memory) return 0;
    if (memory.endsWith('Mi')) return Number.parseInt(memory.slice(0, -2), 10);
    if (memory.endsWith('Gi'))
      return Math.round(Number.parseFloat(memory.slice(0, -2)) * 1024);
    if (memory.endsWith('Ki'))
      return Math.round(Number.parseInt(memory.slice(0, -2), 10) / 1024);
    if (memory.endsWith('M')) return Number.parseInt(memory.slice(0, -1), 10);
    return Math.round(Number.parseInt(memory, 10) / (1024 * 1024));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
