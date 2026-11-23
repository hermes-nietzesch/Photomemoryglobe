import type { NextFunction, Request, Response } from 'express';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export interface LocalApiGuardOptions {
  allowedOrigins?: string[];
}

/**
 * Restricts browser access to the local loopback API:
 * - No wildcard CORS headers are ever emitted.
 * - Sets Cross-Origin-Resource-Policy: same-origin so foreign pages cannot load /api/media images.
 * - Rejects any cross-site Sec-Fetch-Site or disallowed Origin header on all requests.
 * - Requires a trusted local Origin (or Referer origin) on all state-changing requests (POST/PUT/PATCH/DELETE).
 */
export function createLocalApiGuard(options?: LocalApiGuardOptions) {
  const envOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedSet = new Set<string>(
    [...(options?.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS), ...envOrigins]
      .map(normalizeOrigin)
      .filter((v): v is string => v !== null)
  );

  return function localApiGuard(req: Request, res: Response, next: NextFunction): void {
    // Hardening headers: never allow cross-origin resource embedding or MIME sniffing
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');

    const secFetchSite =
      typeof req.headers['sec-fetch-site'] === 'string'
        ? req.headers['sec-fetch-site'].toLowerCase()
        : undefined;

    if (secFetchSite === 'cross-site') {
      res.status(403).json({
        error: 'Forbidden: cross-site browser access to the local photo API is blocked.',
      });
      return;
    }

    const originHeader =
      typeof req.headers.origin === 'string' ? req.headers.origin.trim() : undefined;
    const normalizedOrigin = originHeader ? normalizeOrigin(originHeader) : null;

    // Reject any request carrying a disallowed Origin (including OPTIONS preflights and cross-origin GET/POST)
    if (originHeader !== undefined) {
      if (!normalizedOrigin || !allowedSet.has(normalizedOrigin)) {
        res.status(403).json({
          error: 'Forbidden: untrusted browser origin cannot access the local photo API.',
        });
        return;
      }
    }

    // Explicitly reject unexpected OPTIONS preflights
    if (req.method === 'OPTIONS') {
      res.status(403).json({
        error: 'Forbidden: cross-origin preflight requests are not permitted.',
      });
      return;
    }

    // State-changing requests must carry a trusted local Origin or Referer origin
    if (!SAFE_METHODS.has(req.method.toUpperCase())) {
      const refererHeader =
        typeof req.headers.referer === 'string' ? req.headers.referer.trim() : undefined;
      const effectiveOrigin =
        normalizedOrigin ?? (refererHeader ? normalizeOrigin(refererHeader) : null);

      if (!effectiveOrigin || !allowedSet.has(effectiveOrigin)) {
        res.status(403).json({
          error:
            'Forbidden: state-changing requests must originate from the local Synapse web app.',
        });
        return;
      }

      if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
        res.status(403).json({
          error: 'Forbidden: untrusted fetch context for state-changing request.',
        });
        return;
      }
    }

    next();
  };
}
