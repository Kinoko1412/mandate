'use strict';

/**
 * vLEI-style supplier identity chain (自建 mock — 忠實還原 0815 工作坊林淦鈞
 * 分享的 vLEI 信任鏈行為：GLEIF → QVI → 法人憑證 → 角色憑證(OOR/ECR)，I2I
 * 指標檢查，撤銷連鎖。不依賴任何外部服務；沒有 `vlei` 欄位的供應商一律視為
 * 有效（向下相容，Demo 三幕鎖死劇本行為零影響）。
 */

function nowMs() {
  return Date.now();
}

function isExpired(credential) {
  if (!credential || !credential.expiresAt) return false;
  return new Date(credential.expiresAt).getTime() <= nowMs();
}

/**
 * @returns {{ valid: boolean, chainStatus: string, detail: string }}
 */
function verifySupplierCredentialChain(supplier) {
  if (!supplier || !supplier.vlei) {
    return { valid: true, chainStatus: 'NO_VLEI', detail: '此供應商未使用 vLEI 身分（沿用既有 CarbonPCF/ESG 憑證檢查）。' };
  }

  const { legalEntityCredential: le, roleCredentials } = supplier.vlei;

  if (!le) {
    return { valid: false, chainStatus: 'BROKEN_LINK', detail: '缺少法人憑證。' };
  }
  if (le.status === 'REVOKED') {
    return { valid: false, chainStatus: 'ENTITY_REVOKED', detail: '法人憑證已撤銷，其下所有角色憑證同步失效。' };
  }
  if (isExpired(le)) {
    return { valid: false, chainStatus: 'EXPIRED', detail: '法人憑證已過期。' };
  }

  const roles = Array.isArray(roleCredentials) ? roleCredentials : [];
  if (!roles.length) {
    return { valid: false, chainStatus: 'BROKEN_LINK', detail: '法人底下沒有任何角色憑證，無人被授權簽署碳數據。' };
  }

  for (const role of roles) {
    // I2I（Issuer-to-Issuee）指標檢查：角色憑證的核發依據必須指向這張法人憑證本身。
    if (role.issuerCredentialId !== le.credentialId) {
      return { valid: false, chainStatus: 'BROKEN_LINK', detail: `角色憑證 ${role.credentialId} 未正確指向法人憑證，I2I 檢查失敗。` };
    }
    if (role.status === 'REVOKED') {
      return { valid: false, chainStatus: 'ROLE_REVOKED', detail: `角色憑證 ${role.credentialId}（${role.role || 'ECR'}）已撤銷。` };
    }
    if (isExpired(role)) {
      return { valid: false, chainStatus: 'EXPIRED', detail: `角色憑證 ${role.credentialId} 已過期。` };
    }
  }

  return { valid: true, chainStatus: 'VALID', detail: '法人憑證與角色憑證鏈完整有效，I2I 檢查通過。' };
}

/**
 * Human-only action: revoke a supplier's legal entity credential. Cascades
 * to every role credential issued under it (same supplier's own hierarchy
 * only — does not touch other suppliers).
 */
function revokeLegalEntityCredential(supplier) {
  if (!supplier || !supplier.vlei || !supplier.vlei.legalEntityCredential) {
    return { revoked: false, cascadedRoles: 0 };
  }
  const ts = new Date().toISOString();
  supplier.vlei.legalEntityCredential.status = 'REVOKED';
  supplier.vlei.legalEntityCredential.revokedAt = ts;
  let cascadedRoles = 0;
  for (const role of supplier.vlei.roleCredentials || []) {
    if (role.status !== 'REVOKED') {
      role.status = 'REVOKED';
      role.revokedAt = ts;
      role.revokeReason = 'Cascaded from legal entity credential revocation';
      cascadedRoles += 1;
    }
  }
  return { revoked: true, cascadedRoles };
}

module.exports = { verifySupplierCredentialChain, revokeLegalEntityCredential };
