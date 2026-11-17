import { describe, it, expect } from 'vitest';
import { analyzeFaultTriage } from './assetTriageService';
import { WORK_ORDER_PRIORITIES } from './assetRegistryConstants';

const asset = { categoryId: 'cat_bench', condition: 'fair', status: 'active' };

describe('explainable asset triage', () => {
  it('is deterministic for the same visible inputs', () => {
    const report = { category: 'damage', severity: 'major', description: 'A cracked slat and a loose bolt.' };
    const first = analyzeFaultTriage({ report, asset });
    const second = analyzeFaultTriage({ report, asset });
    expect(first.suggestedPriority).toBe(second.suggestedPriority);
    expect(first.score).toBe(second.score);
    expect(first.factors).toEqual(second.factors);
    expect(first.rulesetVersion).toBe(second.rulesetVersion);
    expect(first.modelId).toBe(second.modelId);
  });

  it('escalates safety hazards on high-footfall assets but never applies itself', () => {
    const result = analyzeFaultTriage({
      report: { category: 'safety_hazard', severity: 'safety_hazard', description: 'Exposed sharp metal edge on the slide.' },
      asset: { categoryId: 'cat_playground', condition: 'poor', status: 'active' },
    });
    expect(result.suggestedPriority).toBe(WORK_ORDER_PRIORITIES.URGENT);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.canApplyAutomatically).toBe(false);
    expect(result.prohibitedUses).toContain('automatic_work_order_closure');
    expect(result.prohibitedUses).toContain('automatic_asset_retirement');
    expect(result.factors.some((factor) => factor.field === 'descriptionTerms')).toBe(true);
    expect(result.inputWindow.assetCondition).toBe('poor');
    expect(result.inputWindow.descriptionTerms).toContain('sharp');
  });

  it('returns a low-priority routine suggestion for cosmetic wear', () => {
    const result = analyzeFaultTriage({
      report: { category: 'wear', severity: 'cosmetic', description: 'Paint is fading on the armrest.' },
      asset,
    });
    expect(result.suggestedPriority).toBe(WORK_ORDER_PRIORITIES.LOW);
    expect(result.suggestedAction).toBe('schedule_routine_inspection');
  });

  it('does not read sensitive or free-form fields outside the input window', () => {
    const result = analyzeFaultTriage({
      report: {
        category: 'wear',
        severity: 'minor',
        description: 'Paint is peeling.',
        reporterEmail: 'resident@example.com',
        phone: '+91 99999 00000',
      },
      asset,
    });
    expect(JSON.stringify(result)).not.toContain('resident@example.com');
    expect(JSON.stringify(result)).not.toContain('99999');
    expect(Object.keys(result.inputWindow).sort()).toEqual([
      'assetCategory',
      'assetCondition',
      'assetStatus',
      'category',
      'descriptionTerms',
      'severity',
    ]);
  });
});
