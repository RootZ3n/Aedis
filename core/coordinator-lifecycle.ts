export function determineRunVerdict(input: {
  cancelled: boolean;
  runPhase: string;
  mergeAction: "apply" | "block" | null;
  verificationVerdict: "pass" | "fail" | "pass-with-warnings" | null;
  judgmentPassed: boolean | null;
  hasFailedNodes: boolean;
}): "success" | "partial" | "failed" | "aborted" {
  if (input.cancelled) return "aborted";
  if (input.runPhase === "failed") return "failed";
  if (input.mergeAction === "block") return "failed";
  if (input.verificationVerdict === "fail") return "failed";
  if (input.judgmentPassed === false) return "failed";
  if (input.verificationVerdict === "pass-with-warnings") return "partial";
  if (input.hasFailedNodes) return "partial";
  return "success";
}
