import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Best-effort command-text guard, not a shell parser or security sandbox.
// Scripts, subprocesses, and tools that execute commands internally can evade it.
export function signingBypassReason(command: string): string | undefined {
  // Catch ordinary quoting and shell line continuations as well as plain flags.
  const text = command.replace(/\\\r?\n/g, "").replace(/['"]/g, "");
  if (/--no-gpg-sign\b/i.test(text)) {
    return "--no-gpg-sign disables commit signing";
  }
  // Git booleans accept false, no, off, 0, and the empty string.
  // Also catches -ccommit.gpgsign=false and config --name=commit.gpgsign --value=false.
  if (/(?:\b|\-c)commit\.gpgsign\s*(?:=\s*|\s+(?:--value(?:=|\s+))?)(?:(?:false|no|off|0)(?=\s|[;&|)]|$)|(?=\s*(?:[;&|)]|$)))/i.test(text)) {
    return "commit.gpgsign must not be disabled";
  }
  // Removing the setting could expose a false or absent inherited default.
  if (/\bconfig\b[^\n;&|]*--(?:unset(?:-all)?|remove-section)\b[^\n;&|]*\bcommit(?:\.gpgsign)?\b/i.test(text) ||
      /\bconfig\b[^\n;&|]*\bcommit\.gpgsign\b[^\n;&|]*--unset(?:-all)?\b/i.test(text)) {
    return "the commit-signing configuration must not be removed";
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command = event.input.command;
    if (typeof command !== "string") return;
    const reason = signingBypassReason(command);
    if (reason) {
      return {
        block: true,
        reason: `Blocked: ${reason}. Signed commits are mandatory. If signing fails, stop and ask the user; do not bypass signing or weaken this guardrail.`,
      };
    }
  });
}
