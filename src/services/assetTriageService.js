/**
 * Deterministic, explainable triage for citizen fault reports.
 *
 * The ruleset is intentionally narrow: it reads only the report category,
 * severity, visible-symptom terms and the asset's public category/condition.
 * It never infers sensitive attributes and never changes a record on its own.
 * Every suggestion records its ruleset version, input window and execution
 * timestamp so a human can audit why it was produced.
 */

import {
  ASSET_CONDITIONS,
  ASSET_STATUS,
  FAULT_CATEGORIES,
  REPORT_SEVERITIES,
  TRIAGE_MODEL_ID,
  TRIAGE_RULESET_VERSION,
  WORK_ORDER_PRIORITIES,
} from './assetRegistryConstants';

const SEVERITY_WEIGHT = Object.freeze({
  [REPORT_SEVERITIES.COSMETIC]: 1,
  [REPORT_SEVERITIES.MINOR]: 2,
  [REPORT_SEVERITIES.MAJOR]: 3,
  [REPORT_SEVERITIES.SAFETY_HAZARD]: 4,
});

const CATEGORY_WEIGHT = Object.freeze({
  [FAULT_CATEGORIES.SAFETY_HAZARD]: 3,
  [FAULT_CATEGORIES.DAMAGE]: 2,
  [FAULT_CATEGORIES.VANDALISM]: 1,
  [FAULT_CATEGORIES.MISSING_PART]: 1,
  [FAULT_CATEGORIES.WEAR]: 0,
  [FAULT_CATEGORIES.CLEANLINESS]: 0,
  [FAULT_CATEGORIES.OTHER]: 0,
});

const HIGH_FOOTFALL_CATEGORIES = new Set(['cat_bus_shelter', 'cat_playground', 'cat_street_light']);

const HAZARD_TERMS = Object.freeze([
  'sharp',
  'broken',
  'cracked',
  'loose',
  'exposed',
  'electrical',
  'sparking',
  'fallen',
  'danger',
  'injury',
  'unsafe',
  'missing',
]);

const descriptionTerms = (description = '') => {
  const text = String(description).toLowerCase();
  return HAZARD_TERMS.filter((term) => text.includes(term)).slice(0, 6);
};

const priorityForScore = (score) => {
  if (score >= 8) return WORK_ORDER_PRIORITIES.URGENT;
  if (score >= 5) return WORK_ORDER_PRIORITIES.HIGH;
  if (score >= 3) return WORK_ORDER_PRIORITIES.MEDIUM;
  return WORK_ORDER_PRIORITIES.LOW;
};

const actionForPriority = (priority) => {
  if (priority === WORK_ORDER_PRIORITIES.URGENT || priority === WORK_ORDER_PRIORITIES.HIGH) return 'create_work_order';
  if (priority === WORK_ORDER_PRIORITIES.MEDIUM) return 'inspect_before_order';
  return 'schedule_routine_inspection';
};

/**
 * @param {{report: object, asset: object}} input
 * @returns {object} a suggestion record with provenance and human-control flags
 */
export const analyzeFaultTriage = ({ report, asset }) => {
  const factors = [];
  const severity = SEVERITY_WEIGHT[report?.severity] || 1;
  factors.push({
    field: 'severity',
    value: report?.severity || 'unknown',
    weight: severity,
    explanation: 'Citizen-reported visible severity.',
  });

  const categoryWeight = CATEGORY_WEIGHT[report?.category] || 0;
  if (categoryWeight > 0) {
    factors.push({
      field: 'category',
      value: report?.category,
      weight: categoryWeight,
      explanation: 'Report category indicates damage or a safety concern.',
    });
  }

  const terms = descriptionTerms(report?.description);
  if (terms.length > 0) {
    factors.push({
      field: 'descriptionTerms',
      value: terms,
      weight: Math.min(3, terms.length),
      explanation: 'Visible-symptom words were present in the citizen description.',
    });
  }

  if (asset?.status === ASSET_STATUS.SUSPENDED) {
    factors.push({
      field: 'assetStatus',
      value: asset.status,
      weight: 2,
      explanation: 'The asset is already on a safety hold.',
    });
  }

  if (asset?.condition === ASSET_CONDITIONS.OUT_OF_SERVICE) {
    factors.push({
      field: 'assetCondition',
      value: asset.condition,
      weight: 2,
      explanation: 'The public condition is already out of service.',
    });
  } else if (asset?.condition === ASSET_CONDITIONS.POOR) {
    factors.push({
      field: 'assetCondition',
      value: asset.condition,
      weight: 1,
      explanation: 'The asset was already recorded as poor.',
    });
  }

  if (HIGH_FOOTFALL_CATEGORIES.has(asset?.categoryId)) {
    factors.push({
      field: 'assetCategory',
      value: asset.categoryId,
      weight: 1,
      explanation: 'This category is used by high-footfall or safety-sensitive locations.',
    });
  }

  if (report?.severity === REPORT_SEVERITIES.SAFETY_HAZARD) {
    factors.push({
      field: 'severity',
      value: report.severity,
      weight: 2,
      explanation: 'A reported safety hazard receives additional urgency.',
    });
  }

  const score = factors.reduce((sum, factor) => sum + Number(factor.weight || 0), 0);
  const suggestedPriority = priorityForScore(score);
  const confidence = Math.min(0.95, Math.round((0.55 + factors.length * 0.05) * 100) / 100);

  return {
    rulesetVersion: TRIAGE_RULESET_VERSION,
    modelId: TRIAGE_MODEL_ID,
    executedAt: new Date().toISOString(),
    inputWindow: {
      category: report?.category || null,
      severity: report?.severity || null,
      descriptionTerms: terms,
      assetCategory: asset?.categoryId || null,
      assetCondition: asset?.condition || null,
      assetStatus: asset?.status || null,
    },
    suggestedPriority,
    suggestedAction: actionForPriority(suggestedPriority),
    confidence,
    score,
    rationale: `Rule set ${TRIAGE_RULESET_VERSION} scored this report ${score} from ${factors.length} visible factor${
      factors.length === 1 ? '' : 's'
    }. The strongest signals were ${factors
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((factor) => `${factor.field} (${String(factor.value)})`)
      .join(', ')}. This is an advisory suggestion only.`,
    factors,
    requiresHumanReview: true,
    canApplyAutomatically: false,
    prohibitedUses: [
      'automatic_asset_retirement',
      'automatic_access_denial',
      'automatic_work_order_closure',
      'automatic_priority_without_human_review',
    ],
    fallbackReason: 'deterministic_rules_only',
  };
};
