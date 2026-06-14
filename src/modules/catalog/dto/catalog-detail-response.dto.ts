import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CatalogResponseDto } from './catalog-response.dto';

export class CatalogUserInputPromptDto {
  @ApiProperty() name: string;
  @ApiPropertyOptional() label?: string;
  @ApiPropertyOptional() default?: string;
  @ApiProperty() sensitive: boolean;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional() placeholder?: string;
  @ApiPropertyOptional({
    description:
      'JavaScript regex source (no surrounding slashes). FE must validate client-side before submitting.',
  })
  pattern?: string;
  @ApiPropertyOptional({
    description:
      'Human-readable description of the pattern, to display when validation fails.',
  })
  patternDescription?: string;
  @ApiPropertyOptional() minLength?: number;
  @ApiPropertyOptional() maxLength?: number;
  @ApiPropertyOptional({
    description:
      'When true the FE must render a second "confirm" field that has to match.',
  })
  confirm?: boolean;
  @ApiPropertyOptional({
    enum: ['email', 'url', 'password', 'text'],
    description:
      'Hint for the FE to pick the right input type and keyboard autocomplete.',
  })
  format?: 'email' | 'url' | 'password' | 'text';
}

export class CatalogEditableEnvDto {
  @ApiProperty() name: string;
  @ApiPropertyOptional() default?: string;
  @ApiPropertyOptional() description?: string;
}

export class CatalogDomainSpecDto {
  @ApiPropertyOptional({
    description:
      'When false, the install wizard must skip endpoint creation. Default true.',
  })
  auto?: boolean;

  @ApiPropertyOptional({
    description:
      'When true the FE may render the FQDN field as user-editable in the install wizard.',
  })
  userCustomizable?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether to provision a TLS certificate. Default true. When false the wizard must hide the cert provider selector.',
  })
  tls?: boolean;

  @ApiPropertyOptional({
    enum: ['ip', 'domain'],
    description:
      'Manifest-declared default for the hostname source. Use it as the initial value of the wizard "hostnameMode" selector; the user can still override unless `userCustomizable=false`. Omitted ⇒ derive from cluster.',
  })
  hostnameMode?: 'ip' | 'domain';

  @ApiPropertyOptional({
    enum: ['http-01', 'dns-01'],
    description:
      'Manifest-declared default for the ACME challenge. Use it as the initial value of the wizard cert-challenge selector. Omitted ⇒ derive from cluster.',
  })
  certChallenge?: 'http-01' | 'dns-01';

  @ApiPropertyOptional({
    enum: ['lets-encrypt', 'lets-encrypt-staging'],
    description:
      'Manifest-declared default certificate authority. Use it as the initial value of the wizard "certificate provider" selector (production vs staging). Omitted ⇒ derive from cluster wildcard issuer.',
  })
  certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';
}

export class CatalogDependencyDto {
  @ApiProperty() ref: string;
  @ApiProperty() as: string;
  @ApiProperty() required: boolean;
  @ApiProperty() reuseExisting: boolean;
}

export class CatalogResourceSpecDto {
  @ApiPropertyOptional({ example: '500m' }) cpu?: string;
  @ApiPropertyOptional({ example: '512Mi' }) memory?: string;
}

export class CatalogResourcesDto {
  @ApiProperty({
    description:
      'Aggregate resource requests declared by the manifest. For standalone/building-block apps this is spec.resources.requests; for composed apps it is the sum across all components. Frontend must use these values — not a generic profile — when calling the cluster resource-availability endpoint.',
  })
  requests: CatalogResourceSpecDto;

  @ApiProperty() limits: CatalogResourceSpecDto;
}

export class CatalogAuthSpecDto {
  @ApiProperty({
    enum: ['native', 'oidc', 'proxy', 'none'],
    isArray: true,
    description:
      'Selectable authentication modes declared by the manifest (spec.auth.modes, or the single spec.auth.mode/default). The install wizard should render an auth-mode selector when this has more than one entry (e.g. Nextcloud → native | Flui SSO); with a single entry it can stay implicit. The chosen value is sent back as InstallCatalogAppDto.authMode.',
    example: ['native', 'oidc'],
  })
  modes: Array<'native' | 'oidc' | 'proxy' | 'none'>;

  @ApiProperty({
    enum: ['native', 'oidc', 'proxy', 'none'],
    description:
      'Initial selection for the auth-mode selector (spec.auth.default, falling back to spec.auth.mode then the first mode). When the user does not change it the backend applies this same default.',
    example: 'native',
  })
  default: 'native' | 'oidc' | 'proxy' | 'none';
}

export class CatalogOptionDto {
  @ApiProperty({
    description:
      'Stable option key. Sent back as InstallCatalogAppDto.options[key] = true | false.',
    example: 'office',
  })
  key: string;

  @ApiProperty({
    description: 'Human-readable label for the toggle.',
    example: 'Office editing (Collabora)',
  })
  label: string;

  @ApiPropertyOptional({
    description: 'Longer help text shown beneath the toggle.',
  })
  description?: string;

  @ApiProperty({
    description:
      'Default enabled state when the user does not toggle it. Mirrors what the backend applies when options[key] is omitted.',
    example: false,
  })
  default: boolean;
}

export class CatalogDetailResponseDto extends CatalogResponseDto {
  @ApiProperty({ type: [CatalogUserInputPromptDto] })
  userInputPrompts: CatalogUserInputPromptDto[];

  @ApiProperty({ type: [CatalogEditableEnvDto] })
  editableEnv: CatalogEditableEnvDto[];

  @ApiProperty({ type: [CatalogDependencyDto] })
  dependencies: CatalogDependencyDto[];

  @ApiProperty({
    type: CatalogResourcesDto,
    description:
      'Resource footprint declared by the manifest. Use requests for the capacity-check call; limits are informational (UI can show "up to X memory").',
  })
  resources: CatalogResourcesDto;

  @ApiProperty({
    description:
      'Default replica count from the manifest (horizontal.min or 1 if HPA is disabled). Multiply requests by this when doing capacity checks.',
    example: 1,
  })
  replicas: number;

  @ApiProperty({
    description:
      'Whether install-time resource overrides (CPU/memory/replicas) actually take effect for this app. True for standalone apps and building blocks (the override is applied to the workload). False for composed apps, whose components always deploy at their manifest defaults — the install wizard MUST hide the override controls and show resources read-only rather than offer a knob that does nothing. Capacity for composed apps is still computed correctly via POST /catalog/:slug/capacity-preview (options-aware).',
    example: true,
  })
  resourceOverridesSupported: boolean;

  @ApiProperty({
    description:
      'True when the manifest declares at least one port with `expose: true` AND `exposure` is `public`. False for building blocks, for standalone apps with `exposure: internal`, and for any app whose ports are all internal. The install wizard MUST skip the Domain step when false; the app detail page MUST hide the "App Endpoints" / DNS / Certificate tabs.',
    example: true,
  })
  exposesPublicEndpoint: boolean;

  @ApiPropertyOptional({
    type: CatalogDomainSpecDto,
    description:
      'Manifest-declared domain/endpoint defaults. Drives the initial values of the install wizard "Domain" step. Omitted when the manifest does not declare `spec.domain` or when `exposesPublicEndpoint=false`.',
  })
  domain?: CatalogDomainSpecDto;

  @ApiPropertyOptional({
    type: CatalogAuthSpecDto,
    description:
      'Manifest-declared authentication options. Present when spec.auth declares one or more modes; omitted when the app has no selectable auth. Drives the install wizard auth-mode selector and is sent back as InstallCatalogAppDto.authMode.',
  })
  auth?: CatalogAuthSpecDto;

  @ApiPropertyOptional({
    type: [CatalogOptionDto],
    description:
      'Manifest-declared install-time feature toggles (spec.options). Present only for composed apps that declare options (e.g. Nextcloud → "office"/Collabora); omitted otherwise. Each toggle the user enables is sent back as InstallCatalogAppDto.options[key] = true.',
  })
  options?: CatalogOptionDto[];

  @ApiProperty({
    enum: ['public', 'internal'],
    description:
      'How this catalog app is reached once installed. `public` (default) creates Ingress + Certificate + DNS on a public hostname. `internal` skips all public exposure: the app lives only on a ClusterIP Service and is reachable only from the Flui dashboard via the ForwardAuth proxy on a wildcard internal hostname. Building blocks are always reported as `internal` regardless of their manifest.',
    example: 'public',
  })
  exposure: 'public' | 'internal';

  @ApiPropertyOptional({
    description:
      'When false, the install wizard must not offer the Internal exposure toggle. Omitted (true) for web UIs; explicitly false for infrastructure apps (queues, proxies, caches) where the ForwardAuth proxy makes no sense. Always false for building blocks.',
  })
  privatizable?: boolean;

  @ApiProperty({
    enum: ['Deployment', 'StatefulSet'],
    description:
      'Kubernetes workload kind Flui will use for this app. Building blocks run as StatefulSet (stable identity, per-pod PVC, headless service); everything else is Deployment. Useful for UI hints ("This app uses persistent storage and ordered startup").',
    example: 'Deployment',
  })
  workloadKind: 'Deployment' | 'StatefulSet';

  @ApiProperty({
    enum: ['shared', 'dedicated'],
    description:
      'How the app stores data once installed. "shared" lets the PVC ride on the cluster-wide flui-shared volume (works on any node). "dedicated" pins the pod to one node so the data sits on local disk there — used by databases that need real fsync/locking. The install wizard should surface this so users know in advance that resizing the host node will briefly stop the app.',
    example: 'shared',
  })
  persistenceScope: 'shared' | 'dedicated';

  @ApiPropertyOptional({
    description:
      'Primary container port the app listens on (first entry in spec.ports). Useful when the app is internal-only and the UI wants to show "postgresql-xxx-svc.ns.svc.cluster.local:5432". Undefined if the manifest declares no ports.',
    example: 5432,
  })
  primaryPort?: number;

  @ApiPropertyOptional({
    description:
      'When present, this app declares runtime linking to one or more building blocks (e.g. pgweb ↔ postgresql, dbgate ↔ mariadb/postgresql/valkey). One entry per BB target. The FE should offer a "Connect" action post-install: POST /catalog/installs/:id/connect body { targetInstallId } where targetInstallId is a running BB install whose catalog slug matches one of the listed `ref`s. envMapping is resolved entirely server-side (envs via secretKeyRef to the BB Secret — passwords never leave the cluster), the FE does NOT need to surface it in any form.',
    isArray: true,
  })
  linkedBuildingBlocks?: Array<{
    ref: string;
    envCount: number;
  }>;

  @ApiProperty({
    description:
      'True when this catalog app can be installed on the cluster passed via `?clusterId=`. Currently the only reason for false is that the app is `exposure: internal` and the cluster has no internal hosting (DNS / wildcard issuer / wildcard internal record). When the request omits `clusterId`, this is always true (no context to discriminate). Use this to disable the install button without attempting the call.',
    default: true,
  })
  installable: boolean;

  @ApiPropertyOptional({
    description:
      'Stable code naming the reason `installable` is false. Same code returned by POST /catalog/:slug/install when it rejects.',
    enum: ['INTERNAL_HOSTING_NOT_AVAILABLE'],
  })
  notInstallableReason?: 'INTERNAL_HOSTING_NOT_AVAILABLE';

  @ApiPropertyOptional({
    description:
      'Granular list of missing prerequisites. Same shape returned by GET /catalog/clusters/:id/capabilities → internalHostingMissing.',
    enum: ['dns_zone', 'wildcard_issuer', 'internal_wildcard_dns'],
    isArray: true,
  })
  notInstallableDetails?: Array<
    'dns_zone' | 'wildcard_issuer' | 'internal_wildcard_dns'
  >;
}
