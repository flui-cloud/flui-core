import { Injectable, Logger } from '@nestjs/common';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEventsGateway } from '../../applications/gateway/application-events.gateway';
import { CrashDiagnosesRepository } from '../repositories/crash-diagnoses.repository';
import { CrashCategory } from '../enums/crash-category.enum';
import { DiagnosisSeverity } from '../enums/diagnosis-severity.enum';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';

/**
 * The one place a "public application, no endpoint" deploy failure becomes a
 * diagnosis a person reading the dashboard can act on.
 *
 * This model was built for a container that dies and leaves a pod behind to
 * inspect — a pod name, a container, an exit code, a log snippet. A public
 * application with no endpoint has none of that: nothing crashed, the pod is
 * healthy, `evidence` has nothing to hold. It still belongs on the same
 * "Diagnoses" tab a person already checks when an application is not working,
 * so this reuses the model instead of inventing a second one — at the cost of
 * two fields that do not quite fit: `podName`, which is `NOT NULL` and here
 * carries a sentinel instead of a real pod; and `category`, which has no
 * value of its own for this (adding one is a Postgres enum migration, not
 * done by this change) — so it borrows `UNKNOWN`, the bucket the taxonomy
 * already sets aside for "not one of the known patterns", which today no
 * other code path writes.
 */
const NO_ENDPOINT_POD_NAME = '(no pod — deploy-level issue)';
const NO_ENDPOINT_PATTERN_KEY = 'no-public-endpoint';
const NO_ENDPOINT_CATEGORY = CrashCategory.UNKNOWN;

@Injectable()
export class EndpointDiagnosisService {
  private readonly logger = new Logger(EndpointDiagnosisService.name);

  constructor(
    private readonly crashDiagnosesRepository: CrashDiagnosesRepository,
    private readonly eventsGateway: ApplicationEventsGateway,
  ) {}

  /**
   * Records why a public application has no endpoint, in the three things a
   * reader needs in order: what is wrong, why, and what to do about it.
   */
  async record(app: ApplicationEntity, cause: string): Promise<void> {
    const entity = await this.crashDiagnosesRepository.create({
      applicationId: app.id,
      podName: NO_ENDPOINT_POD_NAME,
      containerName: null,
      category: NO_ENDPOINT_CATEGORY,
      severity: DiagnosisSeverity.CRITICAL,
      title: 'Public application has no endpoint — nobody can reach it',
      explanation:
        `This application is set to be public, but Flui could not give it a way in from ` +
        `outside — a hostname, a certificate, a route. Reason: ${cause}. ` +
        `The application itself is running and healthy; it is simply unreachable.`,
      evidence: {},
      patternMatchedKey: NO_ENDPOINT_PATTERN_KEY,
      suggestedAction: {
        type: SuggestedActionType.USER_INPUT,
        message:
          'Assign a DNS zone to the cluster, or set deploy.domain.fqdn in flui.yaml to give the application a fixed hostname, ' +
          'or set exposure: internal if it should not be reachable from outside.',
      },
      podSnapshot: null,
    });
    this.eventsGateway.emitCrashDiagnosis(app.id, entity);
  }

  /**
   * Clears any open "no endpoint" diagnosis for this application — the same
   * gesture `CrashRecoveryService` makes for a container that stabilizes,
   * reused here for the same reason: a diagnosis someone already fixed must
   * not keep reading as open.
   */
  async resolve(applicationId: string): Promise<void> {
    const count = await this.crashDiagnosesRepository.markResolvedForContainer(
      applicationId,
      null,
      NO_ENDPOINT_CATEGORY,
    );
    if (count > 0) {
      this.logger.log(
        `Resolved ${count} "no endpoint" diagnosis(es) for app ${applicationId}`,
      );
      this.eventsGateway.emitCrashResolved(applicationId, {
        containerName: null,
        category: NO_ENDPOINT_CATEGORY,
        count,
      });
    }
  }
}
