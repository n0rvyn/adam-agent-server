import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "os";
import { DEFAULT_SENSITIVE_PATHS } from "../../shared/constants.js";

const MAX_SUGGESTIONS = 20;

const suggestDirsQuerySchema = z.object({
  prefix: z.string(),
});

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function matchesDenied(fullPath: string): boolean {
  const resolved = resolve(fullPath);
  for (const denied of DEFAULT_SENSITIVE_PATHS) {
    const deniedExpanded = expandTilde(denied);
    const deniedResolved = resolve(deniedExpanded);
    // Check exact match or prefix match (path is under denied directory)
    if (resolved === deniedResolved || resolved.startsWith(deniedResolved + sep)) return true;
  }
  return false;
}

export async function fsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /fs/suggest-dirs?prefix=<path>
  fastify.get(
    "/fs/suggest-dirs",
    {
      schema: {
        tags: ["FS"],
        summary: "Suggest directory completions",
        description: "Return directory suggestions matching a given path prefix.",
        querystring: {
          type: "object",
          required: ["prefix"],
          properties: {
            prefix: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { prefix: string } }>,
      _reply: FastifyReply,
    ) => {
      const parseResult = suggestDirsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return { suggestions: [] };
      }

      const { prefix } = parseResult.data;

      // Require an absolute-looking prefix (starts with / or ~/)
      if (!prefix.startsWith("/") && !prefix.startsWith("~/")) {
        return { suggestions: [] };
      }

      // Security: reject any prefix under a denied path
      if (matchesDenied(prefix)) {
        return { suggestions: [] };
      }

      const expanded = expandTilde(prefix);

      // Determine the parent directory and the partial basename
      // Handle trailing slash case: /foo/bar/ -> parent = /foo/bar, partial = ""
      let parentDir: string;
      let partial: string;

      if (prefix.endsWith("/")) {
        parentDir = expanded;
        partial = "";
      } else {
        // Find the last separator to split parent from basename
        const lastSep = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf(sep));
        if (lastSep < 0) {
          return { suggestions: [] };
        }
        parentDir = expanded.slice(0, lastSep + 1);
        partial = expanded.slice(lastSep + 1);
      }

      // If the parent doesn't exist or isn't a directory, return empty
      if (!existsSync(parentDir)) {
        return { suggestions: [] };
      }

      let entries: string[];
      try {
        entries = readdirSync(parentDir, { withFileTypes: true })
          .filter((dirent) => dirent.isDirectory())
          .map((dirent) => dirent.name);
      } catch {
        return { suggestions: [] };
      }

      // Filter by prefix (case-insensitive)
      const lowerPartial = partial.toLowerCase();
      const filtered = entries.filter((name) =>
        name.toLowerCase().startsWith(lowerPartial),
      );

      // Skip hidden directories unless the partial itself starts with "."
      const showHidden = partial.startsWith(".");
      const hiddenFiltered = showHidden
        ? filtered
        : filtered.filter((name) => !name.startsWith("."));

      // Security: filter out any suggestion that falls under a denied path
      const safeFiltered = hiddenFiltered.filter(
        (name) => !matchesDenied(join(parentDir, name)),
      );

      // Sort alphabetically
      safeFiltered.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      // Build full absolute paths
      const suggestions = safeFiltered
        .slice(0, MAX_SUGGESTIONS)
        .map((name) => join(parentDir, name));

      return { suggestions };
    },
  );
}
