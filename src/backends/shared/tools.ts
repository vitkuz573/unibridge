import type { ToolChoice, ToolDefinition } from '../../types.js';

// ---------------------------------------------------------------------------
// Native tool calling for the opencode session protocol.
//
// Facts (verified against opencode serve 1.18.x):
// - ``POST /session/{id}/message`` accepts ``tools`` ONLY as a map of local
//   tool names to booleans, e.g. ``{"bash": true}``. An OpenAI-style array of
//   {type,function:{name,description,parameters}} is rejected with 400.
// - ``tool_choice`` accepts ``"auto"`` / ``"none"`` / ``"required"``
//   (a named-function object is also accepted but only `"auto"` is honoured
//   downstream by zen, so we normalise to "auto").
// - The session's permission preset (allow-all, sent at session creation)
//   already governs execution; ``tools`` only toggles availability.
//
// Mapping (no prompt hacks, no schema smuggling):
// - tools absent/empty  -> {}            (no local tools offered)
// - tools non-empty     -> {"*": true}   (all local tools offered)
// - tool_choice "none"      -> "none"
// - tool_choice "required"  -> "required"
// - anything else (incl. named) -> "auto"
// ---------------------------------------------------------------------------

export type SessionTools = Record<string, boolean>;
export type SessionToolChoice = 'auto' | 'none' | 'required';

export function mapToolsForSession(tools: ToolDefinition[] | undefined): SessionTools {
  if (!tools || tools.length === 0) return {};
  return { '*': true };
}

export function mapToolChoiceForSession(choice: ToolChoice | undefined): SessionToolChoice {
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  return 'auto';
}
