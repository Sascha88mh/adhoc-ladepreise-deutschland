// lib/datex2/client.ts
import https from 'https';
import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import { getRedis } from '../redis/client';

/** Redis keys for mTLS credentials (workaround for AWS Lambda 4 KB env-var limit). */
const REDIS_CERT_PEM_KEY = 'mobilithek:cert:pem';
const REDIS_KEY_PEM_KEY  = 'mobilithek:key:pem';
const REDIS_P12_KEY      = 'mobilithek:cert:p12:base64'; // fallback

/**
 * Mobilithek M2M Client
 *
 * Auth: mTLS with X.509 certificate (Maschinenkonto)
 * Base: https://m2m.mobilithek.info  (or :8443 legacy)
 * Protocol: HTTPS REST pull (not SOAP)
 *
 * IMPORTANT: User-Agent must NOT be Python-urllib/3.x → 403
 */
export class MobilithekClient {
  private http: AxiosInstance;
  private subscriptionId: string;

  /**
   * @param subscriptionId  Mobilithek subscription ID.
   *   If omitted, falls back to MOBILITHEK_SUBSCRIPTION_ID env var.
   *   Pass explicitly when running multiple per-feed instances.
   */
  constructor(subscriptionId?: string) {
    const baseURL = process.env.MOBILITHEK_BASE_URL ?? 'https://m2m.mobilithek.info';
    this.subscriptionId = subscriptionId ?? process.env.MOBILITHEK_SUBSCRIPTION_ID ?? '';

    if (!this.subscriptionId) {
      throw new Error(
        'Missing Mobilithek subscription ID — pass as constructor argument or set MOBILITHEK_SUBSCRIPTION_ID'
      );
    }

    // Build mTLS agent
    const httpsAgent = buildMtlsAgent();

    this.http = axios.create({
      baseURL,
      httpsAgent,
      headers: {
        'Accept': 'application/json',
        'User-Agent': process.env.MOBILITHEK_USER_AGENT ?? 'AdhocChargingApp/1.0',
      },
      timeout: 30_000,
    });
  }

  /**
   * Pull latest delta from the AFIR dynamic feed.
   * Returns raw JSON string (parse with parseDatex2Json).
   *
   * Sends If-Modified-Since header for efficient polling.
   * Returns null if server responds 304 Not Modified.
   */
  async pullFeed(lastModified?: string): Promise<{
    data: string;
    newLastModified: string;
    keepAlive: boolean;
    deliveryBreak: boolean;
  } | null> {
    const url = `/mobilithek/api/v1.0/subscription?subscriptionID=${this.subscriptionId}`;

    const headers: Record<string, string> = {};
    if (lastModified) {
      headers['If-Modified-Since'] = lastModified;
    }

    try {
      const res = await this.http.get<string>(url, {
        headers,
        responseType: 'text',
      });

      // Parse exchange flags from JSON (lightweight — avoid importing full parser here)
      let keepAlive = false;
      let deliveryBreak = false;
      try {
        const parsed = JSON.parse(res.data) as {
          d2LogicalModel?: {
            exchange?: { keepAlive?: boolean; deliveryBreak?: boolean };
          };
        };
        keepAlive = parsed.d2LogicalModel?.exchange?.keepAlive ?? false;
        deliveryBreak = parsed.d2LogicalModel?.exchange?.deliveryBreak ?? false;
      } catch {
        // malformed JSON — poller will handle via parseDatex2Json error path
      }

      return {
        data: res.data,
        newLastModified: res.headers['last-modified'] ?? new Date().toUTCString(),
        keepAlive,
        deliveryBreak,
      };
    } catch (err: unknown) {
      // 304 Not Modified → no new data
      if (axios.isAxiosError(err) && err.response?.status === 304) return null;
      throw err;
    }
  }

  /**
   * Fetch the mTLS P12 certificate from Redis and inject it into
   * process.env.MOBILITHEK_CERT_P12_BASE64 so buildMtlsAgent() can use it.
   *
   * Call this once before creating any MobilithekClient instances in
   * environments where the cert cannot be stored as an env var (e.g. Netlify
   * Functions where the AWS Lambda 4 KB env-var limit would be exceeded).
   *
   * Safe to call multiple times — returns early if the env var is already set.
   */
  static async primeCert(): Promise<void> {
    // Already configured via env vars — nothing to do
    if (process.env.MOBILITHEK_CLIENT_CERT && process.env.MOBILITHEK_CLIENT_KEY) return;
    if (process.env.MOBILITHEK_CERT_P12_BASE64) return;

    try {
      const r = getRedis();

      // Preferred: PEM cert + key (avoids PKCS#12 MAC verification issues)
      const [certPem, keyPem] = await r.mget(REDIS_CERT_PEM_KEY, REDIS_KEY_PEM_KEY);
      if (certPem && keyPem) {
        process.env.MOBILITHEK_CLIENT_CERT = certPem;
        process.env.MOBILITHEK_CLIENT_KEY  = keyPem;
        console.log('[MobilithekClient] primeCert: PEM cert+key loaded from Redis ✓');
        return;
      }

      // Fallback: P12 base64 (may fail on older OpenSSL)
      const p12 = await r.get(REDIS_P12_KEY);
      if (p12) {
        process.env.MOBILITHEK_CERT_P12_BASE64 = p12;
        console.log('[MobilithekClient] primeCert: P12 cert loaded from Redis ✓ (' + p12.length + ' chars)');
        return;
      }

      console.warn('[MobilithekClient] primeCert: no cert found in Redis');
    } catch (err) {
      console.error('[MobilithekClient] primeCert: failed to load cert from Redis:', err);
    }
  }

  /**
   * Download OpenAPI spec ZIP for this subscription.
   * Use after subscription activation to get generated TypeScript types.
   */
  async downloadOpenApiSpec(): Promise<Buffer> {
    const res = await this.http.get<Buffer>(
      `/mobilithek/api/v1.0/publication/${this.subscriptionId}/openapi`,
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  }
}

function buildMtlsAgent(): https.Agent {
  // Option A: PEM strings from env vars (recommended for Railway/Vercel)
  if (process.env.MOBILITHEK_CLIENT_CERT && process.env.MOBILITHEK_CLIENT_KEY) {
    return new https.Agent({
      cert: process.env.MOBILITHEK_CLIENT_CERT.replace(/\\n/g, '\n'),
      key: process.env.MOBILITHEK_CLIENT_KEY.replace(/\\n/g, '\n'),
    });
  }

  // Option B: P12 as base64 env var (recommended for Netlify / cloud deployments)
  if (process.env.MOBILITHEK_CERT_P12_BASE64) {
    const pfx = Buffer.from(process.env.MOBILITHEK_CERT_P12_BASE64, 'base64');
    return new https.Agent({
      pfx,
      passphrase: process.env.MOBILITHEK_CERT_PASSWORD ?? '',
    });
  }

  // Option C: P12 file path (for local dev)
  if (process.env.MOBILITHEK_CERT_P12_PATH) {
    const pfx = fs.readFileSync(process.env.MOBILITHEK_CERT_P12_PATH);
    return new https.Agent({
      pfx,
      passphrase: process.env.MOBILITHEK_CERT_PASSWORD ?? '',
    });
  }

  // Fallback: no client cert (will work for dev with mock data)
  console.warn('[MobilithekClient] No client certificate configured — mTLS disabled');
  return new https.Agent();
}
