import chalk from 'chalk';

/**
 * Renders the guard's refusal as something the user can act on.
 *
 * The API refuses a live copy of a database with a structured body rather than
 * a sentence, so every caller can build its own way forward. Here that means
 * printing the command they would have wanted, with their own arguments in it —
 * a refusal that only explains itself makes the user reconstruct the call.
 *
 * Returns false when this was some other error, so the caller falls through to
 * its normal handling.
 */
export function renderCopyRefusal(error: any, retryCommand: string): boolean {
  // `ApiError` carries the response body on `details`; the raw axios shape is
  // accepted too so this keeps working if a caller hands the error through
  // without the client's normalisation.
  const body = error?.details ?? error?.response?.data;
  if (body?.code !== 'VOLUME_COPY_REFUSED') return false;

  // Rendered from the ways forward the API actually offered, never a fixed
  // pair. For a store written in place there is no acknowledgement worth
  // making — the copy would not open — and printing the flag anyway would
  // advertise a way to produce an artifact that cannot be restored.
  const options: string[] = Array.isArray(body.options) ? body.options : [];

  console.log('');
  console.log(chalk.yellow(`  ${body.message ?? 'This copy was refused.'}`));
  console.log('');
  if (options.includes('pause')) {
    console.log(`  ${chalk.bold('Copy it at rest:')}`);
    console.log(chalk.dim(`     ${retryCommand} --pause`));
    console.log('');
  }
  if (options.includes('allowInconsistent')) {
    console.log(
      `  ${chalk.bold('Or take it as it is, knowing it may not restore:')}`,
    );
    console.log(chalk.dim(`     ${retryCommand} --allow-inconsistent`));
    console.log('');
  }
  return true;
}
