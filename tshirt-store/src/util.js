export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function requireFields(body, fields) {
  for (const f of fields) {
    const v = body?.[f];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      throw new HttpError(400, `Missing required field: ${f}`);
    }
  }
}

export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
