const PLAN_STORAGE_DEFAULTS_GB = {
  basic: 100,
  pro: 500,
  business: 500,
  enterprise: 1024,
  custom: 2048
};

function normalizePlanKey(rawPlan) {
  return String(rawPlan || 'basic').trim().toLowerCase() || 'basic';
}

function parseStorageGb(rawValue, fallbackGb) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackGb;
  }

  return numeric;
}

function getPlanStorageGb(planKey) {
  const normalized = normalizePlanKey(planKey);
  const fallbackGb = PLAN_STORAGE_DEFAULTS_GB[normalized] || PLAN_STORAGE_DEFAULTS_GB.basic;
  const envKey = `PLAN_${normalized.toUpperCase()}_STORAGE_GB`;
  return parseStorageGb(process.env[envKey], fallbackGb);
}

function getPlanLabel(planKey) {
  const normalized = normalizePlanKey(planKey);
  const labels = {
    basic: 'Basic',
    pro: 'Pro',
    business: 'Business',
    enterprise: 'Enterprise',
    custom: 'Custom'
  };

  return labels[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getPlanDefinition(planKey) {
  const normalized = normalizePlanKey(planKey);
  const storageGb = getPlanStorageGb(normalized);

  return {
    key: normalized,
    label: getPlanLabel(normalized),
    storage_gb: storageGb,
    quota_bytes: storageGb * 1024 ** 3
  };
}

function listPlanDefinitions() {
  return Object.keys(PLAN_STORAGE_DEFAULTS_GB).map((planKey) => getPlanDefinition(planKey));
}

module.exports = {
  normalizePlanKey,
  getPlanDefinition,
  listPlanDefinitions
};
