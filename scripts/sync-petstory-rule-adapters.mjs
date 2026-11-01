import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 两份正文以 src/rules 为源；构建资源只能由同一源同步，不能另留旧适配文案。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'main/resources/drama/studio-adapters.json');
const sourceFiles = ['src/rules/petstory/seedream.md', 'src/rules/petstory/seedance.md'];
const sourceText = await Promise.all(sourceFiles.map((filename) => fs.readFile(path.join(root, filename), 'utf8')));
const next = JSON.stringify({ seedream: sourceText[0], seedance: sourceText[1], sourceFiles }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await fs.readFile(outputPath, 'utf8') !== next) throw new Error('图片／视频规则资源未同步，请运行 node scripts/sync-petstory-rule-adapters.mjs');
  console.log('PetStory rule adapters match source files.');
} else {
  await fs.writeFile(outputPath, next);
  console.log('PetStory rule adapters synchronized.');
}
