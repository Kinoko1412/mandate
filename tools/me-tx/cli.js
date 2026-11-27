#!/usr/bin/env node
// BEACON KYA spike CLI。用法：
//   node cli.js status                      三個角色（owner/agent/seller）的帳戶、餘額、ME ID
//   node cli.js did <me1...>                查 ME ID
//   node cli.js probe-sim [granter]         唯讀 simulate 路線 2 的 MsgGrant／MsgGrantAllowance（不廣播）
//   node cli.js e2e-authz                   路線 2 實測（需要測試幣）
//   node cli.js e2e-cw <wasm> [--phase nodid] [--code-id N] [--contract me1...]   路線 1 實測（wasm 用 CI optimizer 產物）
//   node cli.js e2e <wasm>                  兩條路線都跑
// 每筆交易的結果會附加到 docs/beacon/SPIKE_RESULT.md 的「實測紀錄」。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const RESULT_MD = path.resolve(__dirname, '..', '..', 'docs', 'beacon', 'SPIKE_RESULT.md');
const MEC = 100_000_000n;
const log = [];
const FAIL_GAS = { gasLimit: 400000 }; // 預期失敗的交易用固定 gas 廣播（約 0.00008 MEC），讓鏈上留下失敗紀錄和 hash
// expect：'success'，或 'fail:<正則>'（失敗原因必須符合，避免把手續費不足之類的錯誤當成「被規則擋下」）
function record(route, step, expect, r) {
  let ok;
  if (expect === 'success') ok = r.code === 0;
  else {
    const re = expect.startsWith('fail:') ? new RegExp(expect.slice(5), 'i') : null;
    ok = r.code !== 0 && r.code !== undefined && (!re || re.test(r.rawLog || ''));
  }
  const row = { route, step, expect: expect.replace(/^fail:.*/, 'fail'), ok, hash: r.hash || '(simulate)', code: r.code, note: (r.rawLog || '').toString().slice(0, 200).replace(/\|/g, '/').replace(/[^ -~一-鿿：，（）]/g, '?') };
  log.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${route}] ${step} expect=${expect} code=${r.code} hash=${row.hash}
      ${row.note}`);
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
  record(R, '超額 0.08 MEC（剩餘額度 0.05）', 'fail:insufficient funds|spend limit|exceed',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, seller, (MEC * 8n) / 100n)])], { feeGranter: owner.address, ...FAIL_GAS }));
  record(R, '付給不在 allow_list 的地址', 'fail:cannot send to|not allowed',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, stranger, 1000n)])], { feeGranter: owner.address, ...FAIL_GAS }));
  record(R, '撤銷：MsgRevoke', 'success', await L.signAndBroadcast(owner, [L.M.revoke(owner.address, agent.address)]));
  record(R, '撤銷後付款 0.01 MEC', 'fail:authorization not found|not found',
    await L.signAndBroadcast(agent, [L.M.exec(agent.address, [L.M.send(owner.address, seller, MEC / 100n)])], { feeGranter: owner.address, ...FAIL_GAS }));
  record(R, '收尾：MsgRevokeAllowance', 'success', await L.signAndBroadcast(owner, [L.M.revokeAllowance(owner.address, agent.address)]));
}

async function e2eCw(wasmPath, opts = {}) {
  // phase：'nodid' = 店主還沒有 ME ID，只驗證「沒有 ME ID 會被擋」；'full' = 完整正向流程（店主要有 ACTIVE ME ID）
  // phase 'subject-low'：TEST ONLY 變體，did_subject 等級低於門檻 → 付款應被擋
  const phase = opts.phase || 'full';
  const owner = await L.loadWallet('owner'); const agent = await L.loadWallet('agent'); const seller = L.addressOf('seller');
  const R = opts.route || '路線1 CosmWasm';
  const minKyc = opts.minKyc ?? 1;
  const budget = opts.budget ?? MEC / 2n;
  let { codeId, contract } = opts;
  if (!codeId && !contract) {
    const wasm = fs.readFileSync(wasmPath);
    console.log(`wasm ${wasmPath} sha256=${crypto.createHash('sha256').update(wasm).digest('hex')} size=${wasm.length}`);
    const r = await L.signAndBroadcast(owner, [L.M.storeCode(owner.address, wasm)]);
    record(R, `MsgStoreCode（wasm sha256 ${crypto.createHash('sha256').update(wasm).digest('hex').slice(0, 12)}…）`, 'success', r);
    codeId = L.findEventAttr(r.events, 'store_code', 'code_id');
    console.log(`code_id=${codeId}`);
    if (!codeId) return;
  }
  if (!contract) {
    const initMsg = { min_kyc_level: minKyc, denom: L.CFG.denom };
    if (opts.didSubject) initMsg.did_subject = opts.didSubject;
    const label = opts.didSubject ? `kya-TEST-ONLY-borrowed-did-${Date.now()}` : `kya-spike-${Date.now()}`;
    const inst = await L.signAndBroadcast(owner, [L.M.instantiate(owner.address, codeId, initMsg, label, budget, owner.address)]);
    record(R, `MsgInstantiateContract(code ${codeId}，預存 ${Number(budget) / 1e8} MEC，min_kyc_level=${minKyc}${opts.didSubject ? `，did_subject=${opts.didSubject}` : ''})`, 'success', inst);
    contract = L.findEventAttr(inst.events, 'instantiate', '_contract_address');
    if (!contract) return;
  }
  console.log(`contract=${contract}`);
  if (opts.didSubject) {
    const cfg = await L.smartQuery(contract, { config: {} });
    console.log('config:', JSON.stringify(cfg));
    log.push({ route: R, step: `query config：did_subject=${cfg.did_subject}，test_only=${cfg.test_only}`, expect: '-', ok: cfg.test_only === true, hash: '-', code: '-', note: `contract ${contract}` });
  }
  const nowS = Math.floor(Date.now() / 1000);
  record(R, '授權：grant（單筆 0.1、每日 0.15 MEC、7 天、allowed=[seller]）', 'success',
    await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { grant: { agent: agent.address, per_tx_limit: String(MEC / 10n), period_limit: String((MEC * 15n) / 100n), period_seconds: 86400, expires_at: nowS + 7 * 86400, allowed_recipients: [seller] } })]));
  const st = await L.smartQuery(contract, { agent_status: { agent: agent.address } });
  console.log('agent_status:', JSON.stringify(st));
  log.push({ route: R, step: `query agent_status：owner_me_id.found=${st.owner_me_id.found}，can_spend_now=${st.can_spend_now}`, expect: '-', ok: true, hash: '-', code: '-', note: (st.owner_me_id.error || st.owner_me_id.status || '').toString().slice(0, 160).replace(/\|/g, '/') });
  if (phase === 'subject-low') {
    record(R, `did_subject 等級低於門檻（min_kyc_level=${minKyc}）→ 付款 0.01 MEC 應被擋`, 'fail:not eligible',
      await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 100n), memo: 'subject-low' } })], FAIL_GAS));
    record(R, '收尾：withdraw 剩餘預算', 'success',
      await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { withdraw: { amount: null } })]));
    return contract;
  }
  if (phase === 'nodid') {
    record(R, '店主沒有 ME ID → 額度內付款 0.05 MEC 應被擋（鏈上 Stargate 查 DID）', 'fail:owner has no ME ID',
      await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 20n), memo: 'no-did' } })], FAIL_GAS));
    console.log(`\n合約保留給 DID 下來後跑正向流程：node cli.js e2e-cw --contract ${contract}`);
    return contract;
  }
  const before = await L.getBalance(seller);
  record(R, '額度內付款 0.05 MEC（合約內即時查店主 ME ID）', 'success',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 20n), memo: 'order-1' } })]));
  console.log(`seller balance +${(await L.getBalance(seller)) - before} umec`);
  record(R, '超過單筆上限 0.2 MEC', 'fail:per-tx limit',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 5n), memo: 'too-big' } })], FAIL_GAS));
  record(R, '額度內再付 0.1 MEC（累計 0.15 = 每期上限）', 'success',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 10n), memo: 'order-2' } })]));
  record(R, '超過每期額度（再付 0.00001 MEC）', 'fail:period allowance',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: '1000', memo: 'period' } })], FAIL_GAS));
  record(R, '付給不在 allowed_recipients 的地址', 'fail:not in allowed_recipients',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: owner.address, amount: '1000', memo: 'stranger' } })], FAIL_GAS));
  record(R, '撤銷：revoke', 'success', await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { revoke: { agent: agent.address } })]));
  record(R, '撤銷後付款 0.01 MEC', 'fail:mandate revoked',
    await L.signAndBroadcast(agent, [L.M.execute(agent.address, contract, { spend: { to: seller, amount: String(MEC / 100n), memo: 'after-revoke' } })], FAIL_GAS));
  console.log('agent_status:', JSON.stringify(await L.smartQuery(contract, { agent_status: { agent: agent.address } })));
  if (opts.keep) {
    const bal = BigInt((await L.smartQuery(contract, { config: {} })).balance.amount);
    const amt = bal > opts.keep ? bal - opts.keep : 0n;
    record(R, `收尾：withdraw ${Number(amt) / 1e8} MEC，合約留 ${Number(bal - amt) / 1e8} MEC 給 Demo`, 'success',
      await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { withdraw: { amount: String(amt) } })]));
  } else {
    record(R, '收尾：withdraw 剩餘預算', 'success',
      await L.signAndBroadcast(owner, [L.M.execute(owner.address, contract, { withdraw: { amount: null } })]));
  }
  return contract;
}

function argOf(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'status') await status();
    else if (cmd === 'did') console.log(JSON.stringify(await L.getDid(args[0]), null, 2));
    else if (cmd === 'probe-sim') await probeSim(args[0]);
    else if (cmd === 'e2e-authz') { await e2eAuthz(); flushLog('路線 2 authz 實測'); }
    else if (cmd === 'e2e-cw-testdid') {
      // TEST ONLY：借用他人公開 DID。用法：e2e-cw-testdid <kya_cw_testdid.wasm> --subject <ACTIVE/TWO 地址> [--low-subject <KYC_LEVEL_ONE 地址>]
      const wasm = args[0]; const subject = argOf(args, '--subject'); const low = argOf(args, '--low-subject');
      const R = '路線1 TEST-ONLY 借用DID';
      for (const [addr, need] of [[subject, 'DID_STATUS_ACTIVE'], [low, null]]) {
        if (!addr) continue;
        const d = await L.getDid(addr);
        console.log(`subject ${addr}: ${JSON.stringify(d.info || d.error)}`);
        if (!d.found || (need && d.info.status !== need)) throw new Error(`subject ${addr} not usable`);
      }
      let codeId = argOf(args, '--code-id');
      if (!codeId) {
        const buf = fs.readFileSync(wasm); const sha = crypto.createHash('sha256').update(buf).digest('hex');
        console.log(`wasm ${wasm} sha256=${sha} size=${buf.length}`);
        const owner = await L.loadWallet('owner');
        const r = await L.signAndBroadcast(owner, [L.M.storeCode(owner.address, buf)]);
        record(R, `MsgStoreCode（TEST ONLY wasm sha256 ${sha.slice(0, 12)}…）`, 'success', r);
        codeId = L.findEventAttr(r.events, 'store_code', 'code_id');
        console.log(`code_id=${codeId}`);
        if (!codeId) { flushLog('TEST ONLY 變體實測'); return; }
      }
      const c1 = await e2eCw(undefined, { codeId, didSubject: subject, minKyc: 1, budget: (MEC * 3n) / 10n, route: R });
      console.log(`positive contract=${c1}`);
      if (low) {
        const c2 = await e2eCw(undefined, { codeId, didSubject: low, minKyc: 2, budget: MEC / 100n, route: R, phase: 'subject-low' });
        console.log(`negative contract=${c2}`);
      }
      flushLog('測試用變體：借用他人公開 DID，只證明合約邏輯，不能當 Demo');
    }
    else if (cmd === 'e2e-cw') { const phase = argOf(args, '--phase'); const keep = argOf(args, '--keep-umec'); await e2eCw(args[0] && !args[0].startsWith('--') ? args[0] : undefined, { phase, codeId: argOf(args, '--code-id'), contract: argOf(args, '--contract'), keep: keep ? BigInt(keep) : undefined }); flushLog(argOf(args, '--title') || `路線 1 CosmWasm 實測${phase === 'nodid' ? '（店主尚無 ME ID）' : ''}`); }
    else if (cmd === 'e2e') { await e2eAuthz(); await e2eCw(args[0]); flushLog('兩條路線實測'); }
    else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).join('\n')); }
  } catch (e) {
    flushLog('實測（中途出錯）');
    console.error('ERROR', e.message);
    process.exit(1);
  }
})();
