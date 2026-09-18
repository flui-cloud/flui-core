import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/**
 * `GET /observability/prometheus/targets` lived here and is gone.
 *
 * It was `@Public()` and answered with the installation's service discovery —
 * cluster-internal addresses, ports and labels — to anyone who asked. It existed
 * for a legacy Prometheus HTTP SD, and a fresh installation has not applied that
 * manifest since the move to vmagent (`k3s-master-init.sh`, manifest list): the
 * only consumer was `04-prometheus-config.yaml`, which is not deployed.
 * `GET /observability/stats` went with it — same source, no caller at all.
 *
 * The controller is kept as the place that says so, and as somewhere for a
 * future observability route that is not one of these.
 */
@ApiTags('Observability')
@ApiBearerAuth()
@Controller('observability')
export class ObservabilityController {}
