#!/usr/bin/env node
// 生成「市场许可证权威」密钥对（阶段 4：付费插件授权验证）
//
// 用法：
//   node publish/market-license-keygen.mjs
//
// 输出：
//   - publicKeyPem  → 复制到客户端 MARKET_LICENSE_PUBLIC_KEY（随发版内置，第三信任锚）
//   - privateKeyPem → 写入 Cloudflare Worker secret：
//       wrangler secret put MARKET_LICENSE_KEY   （粘贴 privateKeyPem 全文）
//
// 注意：私钥永不出云、不进仓库。轮换公钥时旧令牌在公钥退役前仍有效（向后兼容窗口）。

import { generateMarketLicenseKeyPair } from '../market-api/src/lib/licenseSign.mjs';

const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();

console.log('================ 市场许可证权威密钥对 ================');
console.log('\n--- 公钥（SPKI PEM，内置客户端 MARKET_LICENSE_PUBLIC_KEY）---');
console.log(publicKeyPem);
console.log('--- 私钥（PKCS8 PEM，Worker secret MARKET_LICENSE_KEY，切勿入库）---');
console.log(privateKeyPem);
console.log('\n======================================================');
console.log('下一步：');
console.log('  1) 将上面「公钥」整段写入客户端 electron/service/plugin/pluginEntitlement.ts 的 MARKET_LICENSE_PUBLIC_KEY');
console.log('  2) wrangler secret put MARKET_LICENSE_KEY  （粘贴「私钥」整段）');
