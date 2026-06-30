const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

function isThrottledError(payload) {
  return (
    payload?.errors?.some?.(
      (e) =>
        e.extensions?.code === "THROTTLED" ||
        (typeof e.message === "string" && e.message.toLowerCase().includes("throttl"))
    ) ?? false
  );
}

function isPermanentError(payload) {
  if (!payload?.errors?.length) return false;
  return payload.errors.some((e) => {
    const code = e.extensions?.code;
    if (code === "ACCESS_DENIED" || code === "FORBIDDEN") return true;
    const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
    return (
      msg.includes("doesn't exist on type") ||
      msg.includes("syntax error") ||
      msg.includes("cannot query field")
    );
  });
}

// Checks payload.errors (top-level), logs cost and x-request-id. Throws on GraphQL errors.
export function parseGraphQLResponse(payload, operationName, response) {
  const requestId = response?.headers?.get?.("x-request-id") ?? null;

  if (payload.extensions?.cost) {
    console.log(`[GraphQL:${operationName}] cost:`, JSON.stringify(payload.extensions.cost));
  }

  if (payload.errors?.length) {
    const messages = payload.errors.map((e) => e.message).join(", ");
    console.error(
      `[GraphQL:${operationName}] errors: ${messages}` +
        (requestId ? ` (x-request-id: ${requestId})` : "")
    );
    const err = new Error(messages);
    err.graphqlErrors = payload.errors;
    err.requestId = requestId;
    throw err;
  }

  return payload.data;
}

// Idempotent GraphQL query with exponential backoff retry. Do NOT use for mutations —
// retrying a mutation after a lost response risks duplicate operations.
export async function graphqlQueryWithRetry(admin, query, variables, operationName) {
  let lastError = new Error(`[GraphQL:${operationName}] all retries exhausted`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[GraphQL:${operationName}] retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    let response;
    let payload;
    try {
      response = await admin.graphql(query, variables !== undefined ? { variables } : undefined);
      payload = await response.json();
    } catch (networkErr) {
      lastError = networkErr;
      continue;
    }

    if (isPermanentError(payload)) {
      return parseGraphQLResponse(payload, operationName, response);
    }

    if (isThrottledError(payload)) {
      lastError = new Error(`[GraphQL:${operationName}] throttled`);
      continue;
    }

    return parseGraphQLResponse(payload, operationName, response);
  }

  throw lastError;
}
