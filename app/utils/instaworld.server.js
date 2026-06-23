const INSTAWORLD_BASE = "https://one-be.instaworld.pk/logistics/v1";
const TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([429, 502, 503, 504]);

const fetchWithTimeout = async (url, options) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

const withRetry = async (fn, maxAttempts = 3) => {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.name === "AbortError") throw e; // timeout — do not retry
      lastError = e;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
};

export const createShipment = (payload) =>
  withRetry(async () => {
    const res = await fetchWithTimeout(`${INSTAWORLD_BASE}/createShipment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (RETRYABLE.has(res.status)) throw new Error(`HTTP ${res.status}`);
    return res;
  });

export const cancelShipment = (trackingNumber, apiKey) =>
  fetchWithTimeout(`${INSTAWORLD_BASE}/cancelShipment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracking_number: trackingNumber, api_key: apiKey }),
  });
