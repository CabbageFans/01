/**
 * 只识别明确的字幕/对白文字禁令及相反指令，不推断整段创作品质。
 * comparison 仅供验证；调用方保存和采用的仍是模型原文。
 */
export function subtitlePolicyIssues(body: string): string[] {
  // 台词本身可能谈论“字幕”，不能拿角色说的话充当生成约束。
  const comparison = body.replace(/\{[^{}]*用[^{}]+?说\s*[：:][^{}]*\}/gu, '').replace(/\s+/gu, '');
  const subtitleBans = [
    /(?:无|没有)字幕/gu,
    /(?:不|不要|不得|禁止|不允许)(?:生成|添加|叠加|显示|开启|启用|加)字幕/gu,
    /(?:不要|禁止|不得有|不出现|不保留)字幕/gu,
    /(?:关闭|禁用)字幕|字幕(?:关闭|禁用|不生成|不显示)/gu,
  ];
  const dialogueOverlayBans = [
    /(?:无|没有)(?:对白|台词)(?:文字|文本)(?:叠加|覆盖|浮层)/gu,
    /(?:不|不要|不得|禁止|不允许)(?:叠加|添加|显示|呈现)(?:对白|台词)(?:文字|文本)/gu,
    /(?:不|不要|不得|禁止|不允许)(?:将|把)(?:对白|台词)(?:以|作为)(?:文字|文本)(?:叠加|显示|呈现)(?:在画面(?:上|中)?)?/gu,
    /(?:对白|台词)(?:文字|文本)(?:不(?:叠加|显示)|禁止(?:叠加|显示))/gu,
  ];
  const maskBans = (input: string, patterns: RegExp[]): { found: boolean; remainder: string } => {
    let found = false; let remainder = input;
    for (const pattern of patterns) remainder = remainder.replace(pattern, (match: string, offset: number): string => {
      // “不要求无字幕”等是否定禁令，不能作为明确禁止字幕的证据。
      if (/(?:并非|不是|无需|不用|不必|不要|不要求|不需要|不必要求|无需保证|不再|不)(?:全程|全片|始终)?$/u.test(remainder.slice(0, offset))) return match;
      found = true; return ' '.repeat(match.length);
    });
    return { found, remainder };
  };
  const subtitles = maskBans(comparison, subtitleBans);
  const overlays = maskBans(subtitles.remainder, dialogueOverlayBans);
  const issues: string[] = [];
  if (!subtitles.found) issues.push('Seedance 正文缺少明确的无字幕约束');
  if (!overlays.found) issues.push('Seedance 正文缺少明确的禁止对白文字叠加约束');
  // 仅检测可证明的反向文字指令；获准招牌、手机屏幕等画内文字不属于字幕。
  const positiveSubtitle = /(?:添加|生成|叠加|显示|开启|启用|保留|配上|加上|加|呈现|出现|制作|使用)(?:对白|台词|中文|英文|双语|完整|同步|对白文字|台词文字)*字幕|(?:可以|需要|要求|应当|必须|务必)有?字幕|字幕(?:必须|需要|应当|仍然)?(?:显示|出现|开启|保留)/u;
  const positiveOverlay = /(?:将|把)(?:对白|台词)(?:以|作为)(?:文字|文本)(?:叠加|显示|呈现)|(?:叠加|添加|显示|呈现)(?:对白|台词)(?:文字|文本)/u;
  if (positiveSubtitle.test(overlays.remainder) || positiveOverlay.test(overlays.remainder)) issues.push('Seedance 正文同时要求字幕或对白文字叠加，与无字幕约束冲突');
  return issues;
}
