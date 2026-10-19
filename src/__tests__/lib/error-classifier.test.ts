/**
 * Unit tests for error-classifier.
 */

import { describe, it, expect } from "vitest";
import { classifyError } from "../../lib/error-classifier.js";

describe("classifyError", () => {
  describe("AUTH", () => {
    it("classifies 401 as AUTH", () => {
      const result = classifyError("401 Unauthorized");
      expect(result.category).toBe("AUTH");
      expect(result.retryable).toBe(false);
    });

    it("classifies invalid API key as AUTH", () => {
      const result = classifyError("Invalid API key provided");
      expect(result.category).toBe("AUTH");
      expect(result.retryable).toBe(false);
    });

    it("classifies auth failure as AUTH", () => {
      const result = classifyError("Authentication failed: invalid credentials");
      expect(result.category).toBe("AUTH");
      expect(result.retryable).toBe(false);
    });

    it("classifies unauthorized as AUTH", () => {
      const result = classifyError("Unauthorized access denied");
      expect(result.category).toBe("AUTH");
      expect(result.retryable).toBe(false);
    });
  });

  describe("RATE_LIMIT", () => {
    it("classifies 429 as RATE_LIMIT", () => {
      const result = classifyError("429 Too Many Requests");
      expect(result.category).toBe("RATE_LIMIT");
      expect(result.retryable).toBe(true);
      expect(result.sameRoleRetry).toBe(true);
    });

    it("classifies rate limit message as RATE_LIMIT", () => {
      const result = classifyError("Rate limit exceeded. Try again in 60 seconds.");
      expect(result.category).toBe("RATE_LIMIT");
      expect(result.retryable).toBe(true);
    });

    it("classifies quota exhausted as RATE_LIMIT", () => {
      const result = classifyError("API quota exhausted for this month");
      expect(result.category).toBe("RATE_LIMIT");
      expect(result.retryable).toBe(true);
    });
  });

  describe("NETWORK", () => {
    it("classifies ECONNREFUSED as NETWORK", () => {
      const result = classifyError("ECONNREFUSED 127.0.0.1:8080");
      expect(result.category).toBe("NETWORK");
      expect(result.retryable).toBe(true);
      expect(result.sameRoleRetry).toBe(true);
    });

    it("classifies ENOTFOUND as NETWORK", () => {
      const result = classifyError("ENOTFOUND: getaddrinfo failed");
      expect(result.category).toBe("NETWORK");
      expect(result.retryable).toBe(true);
    });

    it("classifies DNS failure as NETWORK", () => {
      const result = classifyError("DNS resolution failed for api.example.com");
      expect(result.category).toBe("NETWORK");
      expect(result.retryable).toBe(true);
    });

    it("classifies connection timeout as NETWORK", () => {
      const result = classifyError("Connection timed out after 30000ms");
      expect(result.category).toBe("NETWORK");
      expect(result.retryable).toBe(true);
    });
  });

  describe("CONTEXT_OVERFLOW", () => {
    it("classifies 'Prompt is too long' as CONTEXT_OVERFLOW", () => {
      const result = classifyError("Prompt is too long");
      expect(result.category).toBe("CONTEXT_OVERFLOW");
      expect(result.retryable).toBe(false);
    });

    it("classifies 'context window exceeded' as CONTEXT_OVERFLOW", () => {
      const result = classifyError("context window exceeded: 200000 tokens");
      expect(result.category).toBe("CONTEXT_OVERFLOW");
      expect(result.retryable).toBe(false);
    });

    it("classifies 'too many tokens' as CONTEXT_OVERFLOW", () => {
      const result = classifyError("Error: too many tokens in request");
      expect(result.category).toBe("CONTEXT_OVERFLOW");
      expect(result.retryable).toBe(false);
    });
  });

  describe("SANDBOX_VIOLATION", () => {
    it("classifies sandbox denial as SANDBOX_VIOLATION", () => {
      const result = classifyError("Operation denied by sandbox policy");
      expect(result.category).toBe("SANDBOX_VIOLATION");
      expect(result.retryable).toBe(false);
      expect(result.differentRoleHelp).toBe(true);
    });

    it("classifies sandbox context flag as SANDBOX_VIOLATION", () => {
      const result = classifyError("Some internal error", { sandboxViolation: true });
      expect(result.category).toBe("SANDBOX_VIOLATION");
      expect(result.retryable).toBe(false);
    });
  });

  describe("TOOL_UNAVAILABLE", () => {
    it("classifies tool not found as TOOL_UNAVAILABLE", () => {
      const result = classifyError("Tool 'WebSearch' not found");
      expect(result.category).toBe("TOOL_UNAVAILABLE");
      expect(result.retryable).toBe(false);
      expect(result.differentRoleHelp).toBe(true);
    });

    it("classifies ENOENT as TOOL_UNAVAILABLE", () => {
      const result = classifyError("ENOENT: no such file or directory");
      expect(result.category).toBe("TOOL_UNAVAILABLE");
      expect(result.retryable).toBe(false);
    });

    it("classifies command not found as TOOL_UNAVAILABLE", () => {
      const result = classifyError("bash: node: command not found");
      expect(result.category).toBe("TOOL_UNAVAILABLE");
      expect(result.retryable).toBe(false);
    });
  });

  describe("TIMEOUT", () => {
    it("classifies generic timeout as TIMEOUT", () => {
      const result = classifyError("Task execution timed out after 300 seconds");
      expect(result.category).toBe("TIMEOUT");
      expect(result.retryable).toBe(true);
      expect(result.sameRoleRetry).toBe(true);
    });
  });

  describe("MALFORMED_REQUEST", () => {
    it("classifies bad request as MALFORMED_REQUEST", () => {
      const result = classifyError("Bad Request: missing required parameter 'url'");
      expect(result.category).toBe("MALFORMED_REQUEST");
      expect(result.retryable).toBe(false);
    });

    it("classifies invalid URL as MALFORMED_REQUEST", () => {
      const result = classifyError("Invalid URL format: https://");
      expect(result.category).toBe("MALFORMED_REQUEST");
      expect(result.retryable).toBe(false);
    });
  });

  describe("INTERNAL_ERROR", () => {
    it("classifies 500 as INTERNAL_ERROR", () => {
      const result = classifyError("500 Internal Server Error");
      expect(result.category).toBe("INTERNAL_ERROR");
      expect(result.retryable).toBe(true);
    });

    it("classifies unexpected error as INTERNAL_ERROR", () => {
      const result = classifyError("Unexpected error: Maximum call stack exceeded");
      expect(result.category).toBe("INTERNAL_ERROR");
      expect(result.retryable).toBe(true);
    });
  });

  describe("UNKNOWN", () => {
    it("returns UNKNOWN for unrecognized errors", () => {
      const result = classifyError("Something completely unexpected happened");
      expect(result.category).toBe("UNKNOWN");
      expect(result.retryable).toBe(false);
      expect(result.userAction).toBeUndefined();
    });

    it("preserves original error string", () => {
      const msg = "Something completely unexpected happened";
      const result = classifyError(msg);
      expect(result.originalError).toBe(msg);
    });
  });

  describe("userAction guidance", () => {
    it("returns userAction for AUTH errors", () => {
      const result = classifyError("401 Unauthorized");
      expect(result.userAction).toBeTruthy();
    });

    it("returns userAction for RATE_LIMIT errors", () => {
      const result = classifyError("429 Too Many Requests");
      expect(result.userAction).toBeTruthy();
    });

    it("returns userAction for NETWORK errors", () => {
      const result = classifyError("ECONNREFUSED 127.0.0.1:8080");
      expect(result.userAction).toBeTruthy();
    });
  });
});
