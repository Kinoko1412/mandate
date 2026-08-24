'use strict';

const normalFixture = require('../fixtures/normal.json');
const { validateCanonical } = require('../packages/contracts/validator');
const { toScaled } = require('../packages/contracts/fixedPoint');
const {
  CarbonCoreError,
  buildCalculationReceipt,
  calculateIntensity,
  allocateAllShipments,
} = require('../services/carbon-core');

class WorkflowAdapterError extends Error {
  constructor(code, message, details = null, retryable = false) {
    super(message);
    this.name = 'WorkflowAdapterError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableError(error) {
  if (error instanceof WorkflowAdapterError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error instanceof CarbonCoreError) {
    return {
      code: error.reasonCode || 'CARBON_CORE_ERROR',
      message: '碳排核心拒絕這組輸入。',
      retryable: false,
      details: { reasonCode: error.reasonCode || 'CARBON_CORE_ERROR' },
    };
  }
  return {
    code: 'CARBON_ADAPTER_ERROR',
    message: '碳排計算暫時無法完成。',
    retryable: false,
    details: null,
  };
}

function assertCanonical(entityName, value) {
  const result = validateCanonical(entityName, value);
  if (!result.valid) {
    throw new WorkflowAdapterError(
      'CONTRACT_VALIDATION_FAILED',
      `${entityName} 不符合 canonical contract。`,
      { entityName, errors: result.errors }
    );
  }
}

function buildCaseCarbon(overrides = {}) {
  const fixture = clone(normalFixture);
  const caseRecord = overrides.caseRecord || fixture.case;
  const installationYear = overrides.installationYear || fixture.installationYear;
  const activities = overrides.activities || fixture.activities;
  const factorSet = overrides.factorSet || fixture.factorSet;
  const policyProfile = overrides.policyProfile || fixture.policyProfile;
  const shipments = overrides.shipments || fixture.shipments;

  try {
    assertCanonical('Case', caseRecord);
    assertCanonical('InstallationYear', installationYear);
    assertCanonical('FactorSet', factorSet);
    assertCanonical('PolicyProfile', policyProfile);

    const receipt = buildCalculationReceipt({
      installationYear,
      activities,
      factorSet,
      policyProfile,
    });
    assertCanonical('CalculationReceipt', receipt);
    const intensity = calculateIntensity({
      annualEmissions: receipt.result,
      productionTonnes: installationYear.productionTonnes,
    });
    const calculatedIntensityScaled = toScaled(intensity.intensity);
    const verifiedIntensityScaled = toScaled(installationYear.verifiedIntensity);
    if (Math.abs(calculatedIntensityScaled - verifiedIntensityScaled) > 1) {
      throw new WorkflowAdapterError(
        'INTENSITY_MISMATCH',
        '重算強度與 installationYear.verifiedIntensity 不一致。',
        {
          calculatedIntensity: intensity.intensity,
          verifiedIntensity: installationYear.verifiedIntensity,
        }
      );
    }
    const allocations = allocateAllShipments({
      installationYear,
      shipments,
      policyProfile,
    });
    const rejected = allocations.find(
      (entry) => !entry.shipment || entry.gateResult.decision !== 'GATE_OK'
    );
    if (rejected) {
      const reasonCode = rejected.gateResult.reasonCodes[0] || 'CARBON_ALLOCATION_REJECTED';
      throw new WorkflowAdapterError(
        reasonCode,
        '批次分攤未通過碳排核心檢查。',
        {
          shipmentId: rejected.gateResult.shipmentId,
          reasonCodes: rejected.gateResult.reasonCodes,
        }
      );
    }

    const allocatedShipments = allocations.map((entry) => {
      assertCanonical('Shipment', entry.shipment);
      return entry.shipment;
    });

    return {
      caseId: caseRecord.caseId,
      installationYear,
      annual: {
        emissions: receipt.result.totalEmissions,
        emissionsUnit: 'tCO2e',
        intensity: intensity.intensity,
        intensityUnit: intensity.unit,
        calculationReceipt: receipt,
      },
      shipments: allocatedShipments,
      demoOnly: true,
    };
  } catch (error) {
    if (error instanceof WorkflowAdapterError) throw error;
    const stable = stableError(error);
    throw new WorkflowAdapterError(
      stable.code,
      stable.message,
      stable.details,
      stable.retryable
    );
  }
}

function unavailableAdapters() {
  return {
    agent: {
      status: 'unavailable',
      verification: 'not_verified',
      execution: 'not_executed',
      demoOnly: true,
    },
    proof: {
      status: 'unavailable',
      verification: 'not_verified',
      demoOnly: true,
    },
    gate: {
      status: 'unavailable',
      verification: 'not_verified',
      demoOnly: true,
    },
  };
}

module.exports = {
  WorkflowAdapterError,
  buildCaseCarbon,
  stableError,
  unavailableAdapters,
};
