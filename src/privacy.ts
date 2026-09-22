/**
 * The outbound boundary. Everything sent to Jev passes through here first.
 *
 * Two tools: `redact` masks things that look like secrets or contact details, and
 * `isSensitive` says "do not send this at all". Callers that get a true from
 * `isSensitive` must skip Jev and take their fail-open path.
 *
 * Ported from hermes-jev-skills jevkit/privacy.py.
 */

const SECRET_WORDS =
  /(?:api[_ -]?key|access[_ -]?token|authorization\s*:|bearer\s+[a-z0-9._-]{8,}|password|passwd|client[_ -]?secret|session[_ -]?cookie|credit[_ -]?card|card[_ -]?number|\bcvv\b|\bssn\b|private[_ -]?key|BEGIN [A-Z ]*PRIVATE KEY)/i;

/** An env-var name is how a secret usually appears in agent output: AWS_SECRET_ACCESS_KEY,
 * STRIPE_SECRET, DB_PASSWORD, GITHUB_TOKEN. Matching only `secret_key` missed every one of
 * them, because the revealing word sits in the middle of the name, not at its end. */
const SECRET_ASSIGNMENT =
  /\b[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)*[_-](?:SECRET|SECRET[_-]?\w*KEY|API[_-]?KEY|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|AUTH)\b\s*[:=]\s*\S*/i;

const SECRET_NAME = /\bsecret[_ -](?:access[_ -])?key\b|\bsecret[_ -]?key\b/i;

const TOKEN_SHAPES =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|apikey_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

const PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;

/** The keyword rules above only fire on a label. A bank alert or an order receipt carries
 * the card number with no trigger word anywhere near it, and "4111 1111 1111 1111" went
 * out verbatim. Luhn is what keeps this from eating order and reference numbers. */
const CARD = /(?<![\d.-])(?:\d[ -]?){12,18}\d(?![\d.-])/;

/** _PHONE is a North American shape: three, three, four. Two lines of a European signature
 * ("+44 20 7946 0958", "+33 1 70 18 99 00") walked straight past it. */
const INTL_PHONE = /(?<![\d+])\+\d{1,3}[\s.-]?(?:\d[\s.-]?){7,13}\d(?!\d)/;

/** A credential with no label at all: an AWS secret access key is 40 base64 characters and
 * the word "secret" never appears beside it in a mail. Mixed case AND a digit is what
 * separates it from a word, a hex digest (already [hex] by the time this runs) or a slug. */
const HIGH_ENTROPY = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/;

/** A UPS tracking number's digit tail parses as country-code + 3 + 3 + 4, so the phone rule
 * ate it: "1Z999AA10123456784" became "1Z999AA[phone]". Protect the specific thing instead
 * of blunting the general rule: hold tracking numbers aside, then put them back. */
const TRACKING = /\b1Z[0-9A-Z]{16}\b/gi;

const LONG_HEX = /\b[a-fA-F0-9]{32,}\b/;

/** Python re.sub replaces every match; a non-global JS regex replaces only the first.
 * Every place a pattern is used as a replacement target goes through here. */
export function g(pattern: RegExp): RegExp {
  return pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

/** The check digit every payment card carries. An order number almost never passes it. */
function luhn(digits: string): boolean {
  let total = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
    alternate = !alternate;
  }
  return total % 10 === 0;
}

function maskCard(match: string): string {
  const digits = match.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[card]" : match;
}

function maskCredential(match: string): string {
  const mixed = /[A-Z]/.test(match) && /[a-z]/.test(match) && /\d/.test(match);
  return mixed ? "[secret]" : match;
}

/** Fold look-alike and invisible characters so a gate cannot be dodged with Unicode. */
export function normalize(text: string): string {
  const folded = text.normalize("NFKC");
  let out = "";
  for (const ch of folded) {
    // Python keeps everything outside {Cf, Cc} plus an explicit \n and \t.
    if (ch === "\n" || ch === "\t" || !/[\p{Cf}\p{Cc}]/u.test(ch)) out += ch;
  }
  return out;
}

export function isSensitive(text: string): boolean {
  const probe = normalize(text);
  return (
    SECRET_WORDS.test(probe) ||
    SECRET_NAME.test(probe) ||
    SECRET_ASSIGNMENT.test(probe) ||
    TOKEN_SHAPES.test(probe)
  );
}

export function redact(text: string, limit = 4000): string {
  let out = normalize(text);
  // Hold tracking numbers aside so the phone rule cannot reach their digits, then put
  // them back before any truncation can cut a placeholder in half.
  const held: string[] = [];
  out = out.replace(g(TRACKING), (m) => {
    held.push(m);
    return `\x00TRK${held.length - 1}\x00`;
  });
  out = out.replace(g(TOKEN_SHAPES), "[secret]");
  // Keep the variable's NAME (it is often the useful signal) and mask only its value.
  out = out.replace(g(SECRET_ASSIGNMENT), (m) => `${m.split(/[:=]/)[0].replace(/\s+$/, "")}=[secret]`);
  out = out.replace(g(LONG_HEX), "[hex]");
  // After [hex], so a digest stays a digest, and before the phone rules, so a spaced
  // card number is not shredded into a "phone" and a remainder.
  out = out.replace(g(HIGH_ENTROPY), maskCredential);
  out = out.replace(g(CARD), maskCard);
  out = out.replace(g(EMAIL), "[email]");
  out = out.replace(g(PHONE), "[phone]");
  out = out.replace(g(INTL_PHONE), "[phone]");
  held.forEach((value, index) => {
    out = out.split(`\x00TRK${index}\x00`).join(value);
  });
  if (out.length > limit) {
    const half = Math.floor(limit / 2);
    out = `${out.slice(0, half)}\n[…]\n${out.slice(-half)}`;
  }
  return out;
}
