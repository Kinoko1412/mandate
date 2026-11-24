// 產生 ME 測試網用的 Cosmos secp256k1 金鑰（m/44'/118'/0'/0/0，前綴 me）。
// 助記詞存到 repo 外面：~/.mandate-secrets/me-testnet-keys.json，畫面只印出地址。
// 用法：node keygen.js owner agent seller
// 已經存在的角色不會被覆蓋。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { stringToPath } = require('@cosmjs/crypto');

const SECRETS_DIR = process.env.MANDATE_SECRETS_DIR || path.join(os.homedir(), '.mandate-secrets');
const FILE = path.join(SECRETS_DIR, 'me-testnet-keys.json');
const HD_PATH = "m/44'/118'/0'/0/0";
const PREFIX = 'me';

async function main() {
  const roles = process.argv.slice(2);
  if (!roles.length) {
    console.error('usage: node keygen.js <role> [role...]');
    process.exit(1);
  }
  const repoRoot = path.resolve(__dirname, '..', '..');
  if (path.resolve(SECRETS_DIR).toLowerCase().startsWith(repoRoot.toLowerCase())) {
    throw new Error('secrets dir must be outside the repo');
  }
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  const store = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  for (const role of roles) {
    if (!store[role]) {
      const w = await DirectSecp256k1HdWallet.generate(24, { prefix: PREFIX, hdPaths: [stringToPath(HD_PATH)] });
      const [acc] = await w.getAccounts();
      store[role] = { mnemonic: w.mnemonic, hdPath: HD_PATH, prefix: PREFIX, address: acc.address, network: 'mechain_400-1 (testnet only)' };
    }
    // 用助記詞重新推導一次，確認存檔內容可以還原出同一個地址
    const w2 = await DirectSecp256k1HdWallet.fromMnemonic(store[role].mnemonic, { prefix: PREFIX, hdPaths: [stringToPath(HD_PATH)] });
    const [acc2] = await w2.getAccounts();
    if (acc2.address !== store[role].address) throw new Error(`address mismatch for ${role}`);
    console.log(`${role}\t${store[role].address}`);
  }
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  console.error(`(mnemonics saved outside repo: ${FILE})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
