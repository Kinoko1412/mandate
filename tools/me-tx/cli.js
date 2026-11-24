#!/usr/bin/env node
// BEACON KYA spike CLI。用法：
//   node cli.js status                      三個角色（owner/agent/seller）的帳戶、餘額、ME ID
//   node cli.js did <me1...>                查 ME ID
//   node cli.js probe-sim [granter]         唯讀 simulate 路線 2 的 MsgGrant／MsgGrantAllowance（不廣播）
//   node cli.js e2e-authz                   路線 2 實測（需要測試幣）
//   node cli.js e2e-cw <path/to/kya_cw.wasm> [--code-id N]   路線 1 實測（需要測試幣，wasm 用 CI optimizer 產物）
//   node cli.js e2e <wasm>                  兩條路線都跑
// 每筆交易的結果會附加到 docs/beacon/SPIKE_RESULT.md 的「實測紀錄」。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const RESULT_MD = path.resolve(__dirname, '..', '..', 'docs', 'beacon', 'SPIKE_RESULT.md');
const MEC = 100_000_000n;
const log = [];
function record(route, step, expect, r) {
  const ok = expect === 'success' ? r.code === 0 : r.code !== 0 && r.code !== undefined;
  const row = { route, step, expect, ok, hash: r.hash || '-', code: r.code, note: (r.rawLog || '').toString().slice(0, 160).replace(/\|/g, '/') };
  log.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${route}] ${step} expect=${expect} code=${r.code} hash=${row.hash}\n      ${row.note}`);
  return ok;
}
function flushLog(title) {
  if (!log.length) return;
  const lines = [`\n### ${title}（${new Date().toISOString()}，chain-id ${L.CFG.chainId}）\n`, '| 路線 | 步驟 | 預期 | 結果 | code | tx hash | 鏈上訊息 |', '|---|---|---|---|---|---|---|'];
  for (const r of log) lines.push(`| ${r.route} | ${r.step} | ${r.expect} | ${r.ok ? '✅' : '❌'} | ${r.code} | \`${r.hash}\` | ${r.note} |`);
  fs.appendFileSync(RESULT_MD, lines.join('\n') + '\n');
  console.log(`\n(appended to ${RESULT_MD})`);
}

async function status() {
  for (const role of ['owner', 'agent', 'seller']) {
    const a = L.addressOf(role);
    const [acc, bal, did] = await Promise.all([L.getAccount(a), L.getBalance(a), L.getDid(a)]);
    console.log(`${role.padEnd(6)} ${a}  exists=${acc.exists} type=${acc.type || '-'} balance=${bal} umec (${Number(bal) / 1e8} MEC)  meId=${did.found ? `${did.info.did} ${did.info.status} ${did.info.kycLevel}` : 'none'}`);
  }
}

async function probeSim(granterArg) {
  // 用一個鏈上已存在的帳戶當 granter 做 simulate。simulate 不驗簽、不改狀態，只看訊息能不能被鏈接受。
  const granter = granterArg || 'me1q30g0n5fe3e2lgsxwsdgt8qn44ajjxseehxhzl';
  const acc = await L.getAccount(granter);
  const agent = L.addressOf('agent'); const seller = L.addressOf('seller');
  const exp = new Date(Date.now() + 86400e3);
  const cases = [
    ['MsgGrant(SendAuthorization + allow_list)', [L.M.grantSend(granter, agent, 10_000_000, [seller], exp)]],
    ['MsgGrantAllowance(BasicAllowance)', [L.M.grantAllowance(granter, agent, 1_000_000, exp)]],
    ['MsgRevoke (no grant yet → should fail)', [L.M.revoke(granter, agent)]],
  ];
  console.log(`granter=${granter} exists=${acc.exists} seq=${acc.sequence}`);
  for (const [name, msgs] of cases) {
    const r = await L.simulate({ msgs, sequence: acc.sequence });
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} gasUsed=${r.gasUsed ?? '-'} ${r.error || ''}`);
  }
}

async function e2eAuthz() {
  const owner = await L.loadWallet('owner'); const agent = await L.loadWallet('agent'); const seller = L.addressOf('seller');
  const stranger = owner.address; // 不在 allow_list 裡的收款人（付回給自己）
  const R = '路線2 authz';
  const exp = new Date(Date.now() + 3600e3);
  const limit = MEC / 10n; // 0.1 MEC
  const ownerDid = await L.getDid(owner.address);
  console.log(`owner ME ID: ${ownerDid.found ? JSON.stringify(ownerDid.info) : 'none'}（路線 2 的 ME ID 檢查不在鏈上強制，只能由賣方或查詢端查）`);
  record(R, '授權：MsgGrant(SendAuthorization 0.1 MEC, allow_list=[seller]) + MsgGrantAllowance', 'success',
    await L.signAndBroadcast(owner, [L.M.grantSend(owner.address, agent.address, limit, [seller], exp), L.M.grantAllowance(owner.address, agent.address, 2_000_000, exp)]));
  const before = await L.getBalance(seller);
  record(R, '額度內付款 0.05 MEC（MsgExec，手續費由 feegrant 付）', 'success',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, seller, MEC / 20n)])], { feeGranter: owner.address }));
  console.log(`seller balance +${(await L.getBalance(seller)) - before} umec`);
  record(R, '超額 0.08 MEC（剩餘額度 0.05）', 'fail',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, seller, (MEC * 8n) / 100n)])], { feeGranter: owner.address }));
  record(R, '付給不在 allow_list 的地址', 'fail',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, stranger, 1000n)])], { feeGranter: owner.address }));
  record(R, '撤銷：MsgRevoke', 'success', await L.signAndBroadcast(owner, [L.M.revoke(owner.address, agent.address)]));
  record(R, '撤銷後付款 0.01 MEC', 'fail',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, seller, MEC / 100n)])], { feeGranter: owner.address }));
  record(R, '收尾：MsgRevokeAllowance', 'success', await L.signAndBroadcast(owner, [L.M.revokeAllowance(owner.address, agent.address)]));
}

async function e2eCw(wasmPath, codeIdArg) {
  const owner = await L.loadWallet('owner'); const agent = await L.loadWallet('agent'); const seller = L.addressOf('seller');
  const R = '路線1 CosmWasm';
  let codeId = codeIdArg;
  if (!codeId) {
    const wasm = fs.readFileSync(wasmPath);
    console.log(`wasm ${wasmPath} sha256=${crypto.createHash('sha256').update(wasm).digest('hex')} size=${wasm.length}`);
    const r = await L.signAndBroadcast(owner, [L.M.storeCode(owner.address, wasm)]);
    record(R, 'MsgStoreCode', 'success', r);
    codeId = L.findEventAttr(r.events, 'store_code', 'code_id');
    if (!codeId) return;
  }
  const inst = await L.signAndBroadcast(owner, [L.M.instantiate(owner.address, codeId, { min_kyc_level: 1, denom: L.CFG.denom }, `kya-spike-${Date.now()}`, MEC / 2n, owner.address)]);
  record(R, `MsgInstantiateContract(code ${codeId}，預存 0.5 MEC)`, 'success', inst);
  const contract = L.findEventAttr(inst.events, 'instantiate', '_contract_address');
  if (!contract) return;
  console.log(`contract=${contract}`);
  const nowS = Math.floor(Date.now() / 1000);
  record(R, '授權：grant（單筆 0.1、每日 0.15 MEC、allowed=[seller]）', 'success',
    await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { grant: { agent: agent.address, per_tx_limit: String(MEC / 10n), period_limit: String((MEC * 15n) / 100n), period_seconds: 86400, expires_at: nowS + 3600, allowed_recipients: [seller] } })]));
  console.log('agent_status:', JSON.stringify(await L.smartQuery(contract, { agent_status: { agent: agent.address } })));
  const before = await L.getBalance(seller);
  record(R, '額度內付款 0.05 MEC（合約內即時查店主 ME ID）', 'success',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 20n), memo: 'order-1' } })]));
  console.log(`seller balance +${(await L.getBalance(seller)) - before} umec`);
  record(R, '超過單筆上限 0.2 MEC', 'fail',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 5n), memo: 'too-big' } })]));
  record(R, '超過每期額度（再付 0.1，累計 0.15 超過剩餘 0.1）', 'fail',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 10n + 1n), memo: 'period' } })]));
  record(R, '付給不在 allowed_recipients 的地址', 'fail',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: owner.address, amount: '1000', memo: 'stranger' } })]));
  record(R, '撤銷：revoke', 'success', await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { revoke: { agent: agent.address } })]));
  record(R, '撤銷後付款 0.01 MEC', 'fail',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 100n), memo: 'after-revoke' } })]));
  console.log('agent_status:', JSON.stringify(await L.smartQuery(contract, { agent_status: { agent: agent.address } })));
  record(R, '收尾：withdraw 剩餘預算', 'success',
    await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { withdraw: { amount: null } })]));
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'status') await status();
    else if (cmd === 'did') console.log(JSON.stringify(await L.getDid(args[0]), null, 2));
    else if (cmd === 'probe-sim') await probeSim(args[0]);
    else if (cmd === 'e2e-authz') { await e2eAuthz(); flushLog('路線 2 authz 實測'); }
    else if (cmd === 'e2e-cw') { const i = args.indexOf('--code-id'); await e2eCw(args[0], i >= 0 ? args[i + 1] : undefined); flushLog('路線 1 CosmWasm 實測'); }
    else if (cmd === 'e2e') { await e2eAuthz(); await e2eCw(args[0]); flushLog('兩條路線實測'); }
    else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).join('\n')); }
  } catch (e) {
    flushLog('實測（中途出錯）');
    console.error('ERROR', e.message);
    process.exit(1);
  }
})();
