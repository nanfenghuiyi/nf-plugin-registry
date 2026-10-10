'use strict';
// registry.sig 信任链单测（阶段 3 / T0 / 设计 4.1、4.3）
//
// 覆盖：
//   1. signRegistryFile 正常签名并写出 64 字节 base64 签名
//   2. 验签通过（原始字节）
//   3. 篡改 registry.json 任一字节 → 验签失败（验收：篡改任一字节拒绝）
//   4. 篡改 registry.sig → 验签失败
//   5. 错误公钥 → 验签失败
//   6. 缺少根私钥 / registry.json 时跳过签名
//
// 运行：npm test（node --test publish/test/）

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const signLib = require('../../lib/sign');
const registrySig = require('../../lib/registrySig');

/** 构建临时 registry 目录（含密钥对与 registry.json） */
function makeTempRegistry(t, registryContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sig-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keysDir = path.join(dir, 'keys');
  signLib.ensureKeys(keysDir); // 生成测试密钥对
  fs.writeFileSync(path.join(dir, 'registry.json'), registryContent, 'utf8');
  return { dir, keysDir, pubPem: fs.readFileSync(path.join(keysDir, 'pub.pem'), 'utf8') };
}

test('signRegistryFile 签名并写出 64 字节 base64 签名', (t) => {
  const { dir, keysDir } = makeTempRegistry(t, '{"plugins":[]}');
  assert.equal(registrySig.signRegistryFile(dir, keysDir), true);
  const sigFile = registrySig.registrySigPath(dir);
  assert.ok(fs.existsSync(sigFile), 'registry.sig 应已写出');
  const sig = Buffer.from(fs.readFileSync(sigFile, 'utf8').trim(), 'base64');
  assert.equal(sig.length, 64, 'Ed25519 签名应为 64 字节');
});

test('原始字节验签通过', (t) => {
  const content = '{"version":1,"plugins":[{"id":"nf.app.demo"}]}';
  const { dir, keysDir, pubPem } = makeTempRegistry(t, content);
  registrySig.signRegistryFile(dir, keysDir);
  const sig = fs.readFileSync(registrySig.registrySigPath(dir), 'utf8');
  assert.equal(registrySig.verifyRegistrySig(Buffer.from(content, 'utf8'), sig, pubPem), true);
});

test('篡改 registry.json 任一字节 → 验签失败', (t) => {
  const content = '{"version":1,"plugins":[{"id":"nf.app.demo","name":"Demo"}]}';
  const { dir, keysDir, pubPem } = makeTempRegistry(t, content);
  registrySig.signRegistryFile(dir, keysDir);
  const sig = fs.readFileSync(registrySig.registrySigPath(dir), 'utf8');

  // 模拟索引被篡改：把公钥/名称等字段逐个改动（任一字节变化都必须被拒绝）
  const tampered = [
    content.replace('Demo', 'Evil'),
    content.replace('nf.app.demo', 'nf.app.evil'),
    content.replace('{"version":1', '{"version":2'),
    content + ' ',
  ];
  for (const bad of tampered) {
    assert.equal(
      registrySig.verifyRegistrySig(Buffer.from(bad, 'utf8'), sig, pubPem),
      false,
      '篡改后必须验签失败: ' + bad,
    );
  }
});

test('篡改 registry.sig → 验签失败', (t) => {
  const content = '{"plugins":[]}';
  const { dir, keysDir, pubPem } = makeTempRegistry(t, content);
  registrySig.signRegistryFile(dir, keysDir);
  const sig = fs.readFileSync(registrySig.registrySigPath(dir), 'utf8').trim();
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.equal(registrySig.verifyRegistrySig(Buffer.from(content, 'utf8'), flipped, pubPem), false);
});

test('错误公钥 → 验签失败', (t) => {
  const content = '{"plugins":[]}';
  const { dir, keysDir } = makeTempRegistry(t, content);
  registrySig.signRegistryFile(dir, keysDir);
  const sig = fs.readFileSync(registrySig.registrySigPath(dir), 'utf8');

  // 另一对无关密钥的公钥（模拟攻击者换钥）
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sig-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const { pub } = signLib.ensureKeys(other);
  assert.equal(
    registrySig.verifyRegistrySig(Buffer.from(content, 'utf8'), sig, fs.readFileSync(pub, 'utf8')),
    false,
  );
});

test('非法签名内容（非 base64 / 长度不符 / 空）→ 验签失败', (t) => {
  const content = '{"plugins":[]}';
  const { dir, keysDir, pubPem } = makeTempRegistry(t, content);
  registrySig.signRegistryFile(dir, keysDir);
  const buf = Buffer.from(content, 'utf8');
  assert.equal(registrySig.verifyRegistrySig(buf, '', pubPem), false);
  assert.equal(registrySig.verifyRegistrySig(buf, 'not-base64!!!', pubPem), false);
  assert.equal(registrySig.verifyRegistrySig(buf, Buffer.alloc(32).toString('base64'), pubPem), false);
});

test('根私钥缺失 → 跳过签名；registry.json 缺失 → 跳过签名', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sig-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 无 keys 目录
  fs.writeFileSync(path.join(dir, 'registry.json'), '{}', 'utf8');
  assert.equal(registrySig.signRegistryFile(dir, path.join(dir, 'nokeys')), false);

  // 有密钥但无 registry.json（独立目录）
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-sig-noreg-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const keysDir = path.join(dir2, 'keys');
  signLib.ensureKeys(keysDir);
  assert.equal(registrySig.signRegistryFile(dir2, keysDir), false);
});
