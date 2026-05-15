import assert from "node:assert/strict";

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export const MODEL_ENV_VAR = "MEM_MOULD_E2E_MODEL";
export const CHILD_MODEL_ENV_VAR = "MEM_MOULD_E2E_CHILD_MODEL";

export function requiredModelSlug(
  explicit?: string,
  options: { cliFlag?: string } = {},
) {
  const modelSlug = explicit?.trim() || process.env[MODEL_ENV_VAR]?.trim();
  const cliHint = options.cliFlag
    ? ` or pass ${options.cliFlag} <provider>/<model>`
    : "";
  assert.ok(modelSlug, `Set ${MODEL_ENV_VAR}=<provider>/<model>${cliHint}.`);
  parseModelSlug(modelSlug);
  return modelSlug;
}

export function optionalModelSlug(envVar: string) {
  const modelSlug = process.env[envVar]?.trim();
  if (!modelSlug) return undefined;
  parseModelSlug(modelSlug);
  return modelSlug;
}

export function parseModelSlug(modelSlug: string): ModelRef {
  const index = modelSlug.indexOf("/");
  assert.ok(
    index > 0 && index < modelSlug.length - 1,
    `model must be provider/model, got: ${modelSlug}`,
  );
  return {
    providerID: modelSlug.slice(0, index),
    modelID: modelSlug.slice(index + 1),
  };
}
