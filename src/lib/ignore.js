// URL ignore rules.
//   chrome://newtab/          plain text: matches any URL containing it (case-insensitive)
//   https://*.example.com/*   with `*`: wildcard match against the whole URL
//   # comment                 ignored

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function compileIgnoreRules(rules) {
  const matchers = [];
  for (const raw of rules ?? []) {
    const rule = String(raw).trim();
    if (!rule || rule.startsWith('#')) continue;
    if (rule.includes('*')) {
      const re = new RegExp(`^${rule.split('*').map(escapeRegExp).join('.*')}$`, 'i');
      matchers.push((url) => re.test(url));
    } else {
      const needle = rule.toLowerCase();
      matchers.push((url) => url.toLowerCase().includes(needle));
    }
  }
  return (url) => matchers.some((match) => match(url));
}
