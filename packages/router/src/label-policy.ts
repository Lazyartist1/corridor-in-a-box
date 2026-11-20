export const ALL_PRICE_LABELS = ["locked", "indicative", "estimated"] as const;

export type AllowedPriceLabel = (typeof ALL_PRICE_LABELS)[number];

export interface LabelPolicy {
  allowedLabels?: readonly AllowedPriceLabel[];
}

export interface LabelledRouteOption {
  receivingDomain: string;
  label: AllowedPriceLabel;
  reasons?: readonly string[];
}

export interface LabelRejectedOption<TOption extends LabelledRouteOption> {
  option: TOption;
  status: "dropped";
  reason: string;
  reasons: string[];
}

export interface LabelPolicyFilterResult<TOption extends LabelledRouteOption> {
  allowed: TOption[];
  dropped: Array<LabelRejectedOption<TOption>>;
}

function formatDisallowedLabelReason(
  label: AllowedPriceLabel,
  allowedLabels: readonly AllowedPriceLabel[],
): string {
  if (allowedLabels.length === 0) {
    return `dropped: label ${label} excluded (no price labels allowed by policy)`;
  }
  return `dropped: label ${label} excluded by policy (allowed: ${allowedLabels.join(", ")})`;
}

/**
 * Enforces `policy.allowedLabels` over priced candidate options. When
 * `allowedLabels` is omitted, all labels remain permitted.
 */
export function filterOptionsByAllowedLabels<TOption extends LabelledRouteOption>(
  options: readonly TOption[],
  policy?: LabelPolicy,
): LabelPolicyFilterResult<TOption> {
  const configured = policy?.allowedLabels;
  if (configured === undefined) {
    return {
      allowed: [...options],
      dropped: [],
    };
  }

  const allowedSet = new Set<AllowedPriceLabel>(configured);
  const allowed: TOption[] = [];
  const dropped: Array<LabelRejectedOption<TOption>> = [];

  for (const option of options) {
    if (allowedSet.has(option.label)) {
      allowed.push(option);
      continue;
    }

    const reason = formatDisallowedLabelReason(option.label, configured);
    const reasons = option.reasons ? [...option.reasons, reason] : [reason];
    dropped.push({
      option,
      status: "dropped",
      reason,
      reasons,
    });
  }

  return { allowed, dropped };
}
