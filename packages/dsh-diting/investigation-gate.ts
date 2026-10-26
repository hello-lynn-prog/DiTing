/** Investigators may gather evidence before submitting conclusions. The coordinator
 * separately verifies that each member has a persisted investigation before review. */
export function requiresInitialInvestigationSubmission(
  _role: string,
  _tool: string,
  _archivedEvidenceCount: number,
  _hasInvestigationArtifact: boolean,
): boolean {
  return false;
}
