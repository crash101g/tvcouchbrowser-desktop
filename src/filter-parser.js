'use strict';
/*
 * A small subset of an Adblock Plus / uBlock Origin filter engine.
 *
 * Supported: `||host^` and `||host/path` network rules (with `$third-party` / `$1p` / `$3p`), `@@`
 * exceptions of the same shapes, `@@||host^$generichide|elemhide`, and standard-CSS cosmetic rules
 * (`##`, `domain##`, `#@#`). Everything else (regex rules, `$domain=`, `$redirect`, scriptlets,
 * procedural selectors) is skipped.
 */
const ANY = 0, FIRST = 1, THIRD = 2;
const PROCEDURAL = /:(has-text|upward|xpath|matches-|remove|style|watch-attr|min-text-length|others|-abp-|contains)/;
const IGNORED_OPTIONS = new Set(['important', 'script', 'image', 'stylesheet', 'css', 'subdocument', 'frame',
  'xmlhttprequest', 'xhr', 'media', 'font', 'object', 'ping', 'other', 'websocket', 'all', '~script', '~image',
  '~stylesheet', '~subdocument', '~xmlhttprequest', '~media', '~font', '~object', '~other']);

function newFilters() {
  return {
    blockHosts: new Map(), allowHosts: new Map(), popupHosts: new Map(), // host -> ANY, FIRST or THIRD
    blockPaths: new Map(), allowPaths: new Map(), // host -> path prefixes
    noCosmeticHosts: new Set(), noGenericHosts: new Set(),
    // Generic hiding: selectors keyed by their leading class or id, plus ones without such a key.
    genericByToken: new Map(), genericComplex: [],
    specific: new Map(), specificExceptions: new Map(), genericExceptions: new Set(),
    ruleCount: 0,
  };
}

const push = (map, key, value) => { const l = map.get(key); if (l) l.push(value); else map.set(key, [value]); };

function parseLine(f, seen, raw) {
  const line = raw.trim();
  if (!line || line[0] === '!' || line[0] === '[') return;
  let i = line.indexOf('#');
  while (i >= 0 && i < line.length - 1) {
    if (line[i + 1] === '#') return parseCosmetic(f, seen, line, i, '##');
    if (line.startsWith('#@#', i)) return parseCosmetic(f, seen, line, i, '#@#');
    // #?#, #$#, #%#, #@?#, #@$#: procedural, CSS-injection and script rules are not supported
    if (line.startsWith('#?#', i) || line.startsWith('#$#', i) || line.startsWith('#%#', i) ||
      line.startsWith('#@?#', i) || line.startsWith('#@$#', i)) return;
    i = line.indexOf('#', i + 1);
  }
  parseNetwork(f, line);
}

function parseCosmetic(f, seen, line, at, sep) {
  const selector = line.slice(at + sep.length).trim();
  if (!selector || selector.startsWith('+js') || selector.startsWith('^') ||
    (selector.includes(':') && PROCEDURAL.test(selector))) return;
  const domains = line.slice(0, at).split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const exception = sep === '#@#';
  if (!domains.length) {
    if (exception) f.genericExceptions.add(selector); else addGeneric(f, seen, selector);
    f.ruleCount++;
    return;
  }
  for (const d of domains) {
    if (d.startsWith('~') || d.endsWith('.*') || d.includes('/')) continue;
    if (exception) push(f.specificExceptions, d, selector);
    else if (!(f.specific.get(d) || []).includes(selector)) push(f.specific, d, selector);
  }
  f.ruleCount++;
}

function addGeneric(f, seen, selector) {
  if (seen.has(selector)) return;
  seen.add(selector);
  // Key by a leading ".class" or "#id" so a page only gets the selectors its elements could match.
  const m = /^[.#][\p{L}_][\p{L}\p{N}_-]*/u.exec(selector);
  if (m) push(f.genericByToken, m[0], selector); else f.genericComplex.push(selector);
}

/** A host named by both a first-party and a third-party rule is blocked either way. */
function addHost(map, host, flags) {
  const had = map.get(host);
  map.set(host, had === undefined ? flags : had === flags ? flags : ANY);
}

function parseNetwork(f, line) {
  let rule = line;
  const allow = rule.startsWith('@@');
  if (allow) rule = rule.slice(2);
  if (!rule.startsWith('||')) return;
  let flags = ANY, cosmeticOff = 0, document = false, popup = false;
  const dollar = rule.indexOf('$');
  if (dollar >= 0) {
    for (const raw of rule.slice(dollar + 1).split(',')) {
      const opt = raw.trim();
      if (opt === 'third-party' || opt === '3p') flags = THIRD;
      else if (opt === '~third-party' || opt === '1p' || opt === 'first-party') flags = FIRST;
      else if (opt === 'generichide' || opt === 'ghide') cosmeticOff = 1;
      else if (opt === 'elemhide' || opt === 'ehide') cosmeticOff = 2;
      else if (opt === 'document' || opt === 'doc') { cosmeticOff = 2; document = true; }
      else if (opt === 'popup') popup = true;
      else if (!IGNORED_OPTIONS.has(opt)) return; // domain=, redirect=, removeparam=, csp=, badfilter...
    }
    rule = rule.slice(0, dollar);
  }
  rule = rule.slice(2).toLowerCase();
  let hostEnd = rule.search(/[\^/]/);
  if (hostEnd < 0) hostEnd = rule.length;
  const host = rule.slice(0, hostEnd);
  if (host.length < 3 || host[0] === '.' || host[0] === '-' || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return;
  let rest = rule.slice(hostEnd);
  const whole = rest === '' || rest === '^' || rest === '^|';
  if (popup) {
    // Only whole-site pop-up rules; pop-up exceptions are rare.
    if (allow || !whole) return;
    addHost(f.popupHosts, host, flags);
    f.ruleCount++;
    return;
  }
  if (allow && cosmeticOff > 0) {
    (cosmeticOff === 1 ? f.noGenericHosts : f.noCosmeticHosts).add(host);
    f.ruleCount++;
    // $generichide / $elemhide only switch hiding off; $document also allows every request.
    if (!document) return;
  }
  if (whole) {
    addHost(allow ? f.allowHosts : f.blockHosts, host, flags);
  } else if (rest.startsWith('/')) {
    rest = rest.replace(/[\^*|]+$/, '');
    if (rest.includes('*') || rest.includes('^') || rest.length < 2) return;
    push(allow ? f.allowPaths : f.blockPaths, host, rest);
  } else return;
  f.ruleCount++;
}

function coveredByHost(hosts, host) {
  for (let h = host; ;) {
    if (hosts.get(h) === ANY) return true;
    const dot = h.indexOf('.');
    if (dot < 0 || dot === h.length - 1) return false;
    h = h.slice(dot + 1);
  }
}

/** Parses the text of each list into one Filters object. */
function parseLists(texts) {
  const f = newFilters();
  const seen = new Set();
  for (const text of texts) for (const line of text.split('\n')) parseLine(f, seen, line);
  // A path rule under a host that is blocked outright can never decide anything.
  for (const host of f.blockPaths.keys()) if (coveredByHost(f.blockHosts, host)) f.blockPaths.delete(host);
  return f;
}

module.exports = { parseLists, newFilters, ANY, FIRST, THIRD };
