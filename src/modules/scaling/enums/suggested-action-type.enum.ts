export enum SuggestedActionType {
  USER_INPUT = 'user_input',
  REDEPLOY = 'redeploy',
  MANUAL = 'manual',
  /** Carries resource values Flui applies when a person accepts it. */
  RESOURCES = 'resources',
  /** Written by an automatic fix Flui no longer makes; kept for the diagnoses it left. */
  AUTO = 'auto',
}
