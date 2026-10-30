/** 检查真实提交署名；不改写上游来源、许可证或历史正文。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** @param {string[]} args @returns {string} */
function git(args) {
  return execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** @param {string} value @param {string} field @returns {void} */
function checkIdentity(value, field) {
  if (value.normalize('NFKC').toLowerCase().includes('dorakoo')) {
    throw new Error(`${field} 包含禁止的 dorakoo 署名；请使用实际贡献者身份。`);
  }
}

/** @param {string} message @param {string} source @returns {void} */
function checkCoauthors(message, source) {
  // 只检查共同作者字段，旧 PR 链接、来源说明和许可证不属于署名。
  const trailers = message.matchAll(/(?:^|\n)[ \t]*co-authored-by[ \t]*:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/gi);
  for (const trailer of trailers) checkIdentity(trailer[1], `${source} Co-authored-by`);
}

try {
  const { values } = parseArgs({ options: {
    identity: { type: 'boolean' },
    'message-file': { type: 'string' },
    history: { type: 'string' },
  } });
  if (!values.identity && !values['message-file'] && !values.history) {
    throw new Error('用法：--identity / --message-file <文件> / --history <提交或范围>');
  }
  if (values.identity) {
    checkIdentity(git(['var', 'GIT_AUTHOR_IDENT']), '当前作者');
    checkIdentity(git(['var', 'GIT_COMMITTER_IDENT']), '当前提交者');
  }
  if (values['message-file']) checkCoauthors(readFileSync(values['message-file'], 'utf8'), '提交消息');
  if (values.history) {
    if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
      throw new Error('需要完整提交历史；先 git fetch --unshallow，再检查。');
    }
    // 小写格式读取原始作者，不受 .mailmap 或本机显示设置影响。
    const fields = git(['log', '--no-use-mailmap', '-z', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B', values.history, '--']).split('\0');
    if (fields.pop() !== '' || fields.length === 0 || fields.length % 6 !== 0) {
      throw new Error('提交历史读取为空或格式异常。');
    }
    for (let index = 0; index < fields.length; index += 6) {
      const [sha, author, email, committer, committerEmail, message] = fields.slice(index, index + 6);
      checkIdentity(`${author} <${email}>`, `${sha.slice(0, 12)} 作者`);
      checkIdentity(`${committer} <${committerEmail}>`, `${sha.slice(0, 12)} 提交者`);
      checkCoauthors(message, sha.slice(0, 12));
    }
    console.log(`提交署名检查通过：${fields.length / 6} 条提交。`);
  } else {
    console.log('当前提交署名检查通过。');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '提交署名检查失败。');
  process.exitCode = 1;
}
