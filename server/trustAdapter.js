'use strict';

const TRUST_SERVICE_NAMES = ['proof', 'gate'];
const STABLE_REASON_CODE = /^[A-Z][A-Z0-9_]*$/;

function unavailableResult() {
  return {
    proof: {
      status: 'unavailable',
      verification: 'not_verified',
      checks: [],
      reasonCodes: ['PROOF_SERVICE_UNAVAILABLE'],
    },
    gate: {
      status: 'unavailable',
      verification: 'not_verified',
      checks: [],
      reasonCodes: ['GATE_SERVICE_UNAVAILABLE'],
    },
  };
}

function validateServiceResult(name, value) {
  if (!TRUST_SERVICE_NAMES.includes(name) || !value || typeof value !== 'object') {
    throw new TypeError('Invalid trust adapter service result.');
  }
  if (!['available', 'unavailable', 'error'].includes(value.status)) {
    throw new TypeError('Invalid trust adapter service status.');
  }
  if (!['verified', 'not_verified', 'failed'].includes(value.verification)) {
    throw new TypeError('Invalid trust adapter verification.');
  }
  if (value.status === 'available' && value.verification === 'not_verified') {
    throw new TypeError('Available trust adapter service must be verified or failed.');
  }
  if (value.verification === 'verified' && value.status !== 'available') {
    throw new TypeError('Verified trust adapter service must be available.');
  }
  if (!Array.isArray(value.checks) || !Array.isArray(value.reasonCodes)) {
    throw new TypeError('Trust adapter checks and reasonCodes must be arrays.');
  }
  if (value.reasonCodes.some((code) => !STABLE_REASON_CODE.test(code))) {
    throw new TypeError('Trust adapter reasonCodes must be stable codes.');
  }
  if (
    value.verification === 'verified' &&
    (typeof value.inputHash !== 'string' || !value.inputHash.trim())
  ) {
    throw new TypeError('Verified trust adapter service requires inputHash.');
  }
  return {
    status: value.status,
    verification: value.verification,
    checks: value.checks,
    reasonCodes: value.reasonCodes,
    ...(value.inputHash ? { inputHash: value.inputHash } : {}),
  };
}

function validateResult(result) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('Invalid trust adapter result.');
  }
  const keys = Object.keys(result);
  if (
    keys.length !== TRUST_SERVICE_NAMES.length ||
    TRUST_SERVICE_NAMES.some((name) => !keys.includes(name))
  ) {
    throw new TypeError('Trust adapter result must include proof and gate only.');
  }
  return Object.fromEntries(
    TRUST_SERVICE_NAMES.map((name) => [name, validateServiceResult(name, result[name])])
  );
}

let evaluator = async function evaluateUnavailable() {
  return unavailableResult();
};

async function evaluate(input) {
  return validateResult(await evaluator(input));
}

function setEvaluatorForTests(nextEvaluator) {
  if (typeof nextEvaluator !== 'function') {
    throw new TypeError('Trust evaluator must be a function.');
  }
  evaluator = nextEvaluator;
}

function resetEvaluatorForTests() {
  evaluator = async function evaluateUnavailable() {
    return unavailableResult();
  };
}

module.exports = {
  evaluate,
  resetEvaluatorForTests,
  setEvaluatorForTests,
  unavailableResult,
  validateResult,
};
