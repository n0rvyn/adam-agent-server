import { useEffect, useState } from "react";
import { request } from "../../client.js";

interface RoleSummary {
  id: string;
  name: string;
}

interface RolesResponse {
  roles: RoleSummary[];
}

/**
 * Fetch /roles once and provide a roleId → roleName lookup.
 * Returns "?" for unknown roleId (covers race between role creation and chat_message).
 */
export function useRoleNames(): {
  getName: (roleId: string | undefined | null) => string;
  loaded: boolean;
} {
  const [map, setMap] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const resp = await request<RolesResponse>("/roles");
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const r of resp.roles) m.set(r.id, r.name);
        setMap(m);
      } catch {
        // /roles unavailable — return "?" for any lookup
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  return {
    getName: (roleId) => (roleId && map.get(roleId)) || "?",
    loaded,
  };
}
