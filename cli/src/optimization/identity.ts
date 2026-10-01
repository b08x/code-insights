/**
 * Student identity (plan step 8): who is being prompted, as runner + model + variant.
 *
 * Prompt versions are scoped to an identity (a prompt tuned for one model is never applied to
 * another), and every analysis row records the identity that produced it. Two code paths produce
 * identities and must agree on the key format:
 *   - CLI / queue: a native runner (`claude-code-native`, `codex-native`, ...) or a provider runner
 *   - server / dashboard: always the configured provider, `provider:<llm.provider>` + `<llm.model>`
 *
 * Native CLI runners report their configured model, or a legacy label ('claude-native', ...) when
 * the CLI picks its own default. Every runner's `name`/`model`/`variant` equal the
 * `provider`/`model` its calls report, so the identity resolved before the first call equals the
 * identity recorded after it (identityForCall), unless a fallback runner answered.
 */

import type { ClaudeInsightConfig } from '../types.js';

export interface StudentIdentity {
  /** Runner id: a native runner name, or `provider:<id>` for the shared LLM transport. */
  runner: string;
  model: string | null;
  variant: string | null;
}

/** The fields of a RunAnalysisResult that identify the student (structural, avoids a cycle). */
export interface RunResultIdentityFields {
  provider: string;
  model: string;
}

/** The fields of an AnalysisRunner that identify the student before any call is made. */
export interface RunnerIdentityFields {
  name: string;
  provider?: string;
  model?: string;
  variant?: string;
}

const PROVIDER_PREFIX = 'provider:';

/** Separator between identity-key components; forbidden inside any component. */
const KEY_SEPARATOR = '|';

/**
 * Stable string form stored in `student_identity` columns and used to key prompt versions.
 * Throws when a component contains '|': the key would be ambiguous (two identities could
 * share one key, and a prompt tuned for one would be applied to the other).
 */
export function identityKey(identity: StudentIdentity): string {
  for (const [field, value] of [['runner', identity.runner], ['model', identity.model], ['variant', identity.variant]] as const) {
    if (value?.includes(KEY_SEPARATOR)) {
      throw new Error(`Invalid student identity: ${field} must not contain '${KEY_SEPARATOR}' (got ${JSON.stringify(value)}).`);
    }
  }
  return [identity.runner, identity.model ?? '', identity.variant ?? ''].join(KEY_SEPARATOR);
}

export function parseIdentityKey(key: string): StudentIdentity | null {
  const parts = key.split('|');
  if (parts.length !== 3 || !parts[0]) return null;
  return { runner: parts[0], model: parts[1] || null, variant: parts[2] || null };
}

/**
 * Identity of a provider-backed student (server path, and the CLI when it uses the provider
 * transport): `provider:<llm.provider>` / `<llm.model>`.
 */
export function providerIdentity(provider: string, model: string | null, variant: string | null = null): StudentIdentity {
  return { runner: `${PROVIDER_PREFIX}${provider}`, model, variant };
}

/**
 * Identity from the runner's own metadata, known before the first call (used to resolve the
 * active prompt version). A runner with `provider` set is backed by the shared LLM transport.
 */
export function identityFromRunner(
  runner: RunnerIdentityFields,
  variant: string | null = runner.variant ?? null,
): StudentIdentity {
  if (runner.provider) return providerIdentity(runner.provider, runner.model ?? null, variant);
  return { runner: runner.name, model: runner.model ?? null, variant };
}

/**
 * Identity from what the call actually reported. Preferred for recording provenance because
 * FallbackNativeRunner reports the primary runner's name even after falling back; the result's
 * provider/model are the only truthful record of what answered.
 */
export function identityFromRunResult(
  result: RunResultIdentityFields,
  opts: { providerBacked: boolean; variant?: string | null },
): StudentIdentity {
  const variant = opts.variant ?? null;
  return opts.providerBacked
    ? providerIdentity(result.provider, result.model, variant)
    : { runner: result.provider, model: result.model, variant };
}

/**
 * Identity to record for a call made through `runner`. The variant is kept only when the runner
 * itself answered: a fallback runner (FallbackNativeRunner) runs with its CLI's defaults, and its
 * result names a different provider than `runner.name`.
 */
export function identityForCall(runner: RunnerIdentityFields, result: RunResultIdentityFields): StudentIdentity {
  const providerBacked = runner.provider !== undefined;
  const answeredByRunner = providerBacked || result.provider === runner.name;
  return identityFromRunResult(result, {
    providerBacked,
    variant: answeredByRunner ? runner.variant ?? null : null,
  });
}

/**
 * Current identity for a process. Pass the selected runner on the CLI path; omit it on the
 * server path, where the configured `dashboard.llm` is always the student. Null when nothing is
 * configured (callers then record no identity and resolve the built-in prompt).
 */
export function currentIdentity(
  config: ClaudeInsightConfig | null,
  runner?: RunnerIdentityFields,
): StudentIdentity | null {
  const identity = runner
    ? identityFromRunner(runner)
    : config?.dashboard?.llm
      ? providerIdentity(config.dashboard.llm.provider, config.dashboard.llm.model ?? null)
      : null;
  // Validate eagerly (e.g. a hand-edited dashboard.llm.model containing '|').
  if (identity) identityKey(identity);
  return identity;
}

/**
 * True when the identity names a concrete model. A native CLI that picks its own default reports
 * a legacy label (`claude-native`, `opencode-default`, ...): the model behind it can change
 * silently, so a prompt promoted for it would be applied to whatever the CLI resolves later
 * (plan carry-forward 2). Such identities can be optimized and gated but not promoted.
 */
export function isPromotableIdentity(identity: StudentIdentity): boolean {
  return !!identity.model && !/-(native|default)$/.test(identity.model);
}
