// URL ignore rules.
//   chrome://newtab/          plain text: matches any URL containing it (case-insensitive)
//   https://*.example.com/*   with `*`: wildcard match against the whole URL
//   # comment                 ignored (written by the old one-rule-per-line text box)

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** 'contains', 'wildcard', or 'comment' for a rule; null for an empty one. */
export function ruleKind(rule) {
  const text = String(rule ?? '').trim();
  if (!text) return null;
  if (text.startsWith('#')) return 'comment';
  return text.includes('*') ? 'wildcard' : 'contains';
}

/** Rules match case-insensitively, so `YouTube.com` and `youtube.com ` are the same rule. */
export const ruleKey = (rule) => String(rule ?? '').trim().toLowerCase();

export function compileIgnoreRules(rules) {
  const matchers = [];
  for (const raw of rules ?? []) {
    const rule = String(raw).trim();
    const kind = ruleKind(rule);
    if (kind === 'wildcard') {
      const re = new RegExp(`^${rule.split('*').map(escapeRegExp).join('.*')}$`, 'i');
      matchers.push((url) => re.test(url));
    } else if (kind === 'contains') {
      const needle = rule.toLowerCase();
      matchers.push((url) => url.toLowerCase().includes(needle));
    }
  }
  return (url) => matchers.some((match) => match(url));
}
