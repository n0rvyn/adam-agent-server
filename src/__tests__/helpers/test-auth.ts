/**
 * Shared test API key. Used by any test that calls buildApp() or fetches
 * an authenticated endpoint from a test server.
 *
 * Since auth is always enforced (src/server/app.ts), tests must pass this
 * key as the second arg to buildApp() and include it in the `x-api-key`
 * header for HTTP requests, or as the `api_key` query param for WebSockets.
 */
export const TEST_API_KEY = "test-api-key-deadbeef-deadbeef-deadbeef-deadbeef-deadbeef-deadbeef";
