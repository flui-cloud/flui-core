import { SANDBOX_GUEST_REQUEST } from './sandbox-fence.guard';

/** Whether the request comes from a demo guest, as marked by the sandbox fence. */
export function isSandboxGuestRequest(req: unknown): boolean {
  return (
    (req as { [SANDBOX_GUEST_REQUEST]?: unknown })?.[SANDBOX_GUEST_REQUEST] !==
    undefined
  );
}

/** Platform storage — a registered destination or a bucket made on the operator's account — is never a guest's to write to. */
export const GUEST_STORAGE_REFUSAL =
  'Backups to the platform’s storage are not available to demo guests; download the backup instead.';
