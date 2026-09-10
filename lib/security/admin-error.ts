// 管理RPCにも原稿・Secret・プロバイダの自由文を返さない。既知の分類だけ渡す。
export function adminErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known = message.match(/\b(embedding_http_\d{3}(?:_(?:INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND|RESOURCE_EXHAUSTED|UNAUTHENTICATED|API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED|BILLING_DISABLED|QUOTA_ZERO|QUOTA_FREE_TIER|QUOTA_DAILY))*|invalid_embedding|provider_not_configured|embedding_index_mismatch)\b/);
  if (known) return known[1];
  if (/D1_ERROR/.test(message)) return "database_error";
  if (/Vectorize/.test(message)) return "vector_index_error";
  if (/cache/i.test(message) && /implemented|support/i.test(message)) return "request_cache_unsupported";
  if (/context|AsyncLocalStorage|storage/i.test(message)) return "request_context_missing";
  if (/header/i.test(message)) return "request_header_invalid";
  if (/network|fetch failed|DNS/i.test(message)) return "provider_network_error";
  if (error instanceof Error && error.name === "TimeoutError") return "operation_timeout";
  if (error instanceof Error && error.name === "TypeError") return "provider_type_error";
  return "admin_operation_failed";
}
