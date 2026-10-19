import { fireEvent, render, screen, within } from "../../utils/test-utils";
import { describe, expect, it, vi } from "vitest";
import { RoleProjectPlugins } from "@/components/plugins/RoleProjectPlugins";
import type { RoleGroup } from "@/hooks/usePluginsWithUsage";

const groups: RoleGroup[] = [
  {
    roleId: "r1",
    roleName: "Engineer",
    workspacePath: "/work/engineer",
    plugins: [
      {
        pluginId: "dev-workflow@indie",
        name: "dev-workflow",
        version: "1.0.0",
        installPath: "/work/engineer/plugins/dev-workflow",
        userScopeVersion: "1.2.0",
        isOutdated: true,
        isRoleOnly: false,
      },
    ],
  },
  {
    roleId: "r2",
    roleName: "Reviewer",
    workspacePath: "/work/reviewer",
    plugins: [
      {
        pluginId: "review-helper@indie",
        name: "review-helper",
        version: "1.0.0",
        installPath: "/work/reviewer/plugins/review-helper",
        userScopeVersion: null,
        isOutdated: false,
        isRoleOnly: true,
      },
    ],
  },
];

describe("RoleProjectPlugins", () => {
  it("renders grouped role sections in full layout", () => {
    render(
      <RoleProjectPlugins
        groups={groups}
        layout="full"
        onUninstall={vi.fn().mockResolvedValue(undefined)}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        operatingKey={null}
      />,
    );

    expect(screen.getByRole("heading", { name: "Engineer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reviewer" })).toBeInTheDocument();
    expect(screen.getByText("⚠ behind user (v1.2.0)")).toBeInTheDocument();
    expect(screen.getByText("Role-only")).toBeInTheDocument();
  });

  it("renders only the requested role in single-role layout", () => {
    render(
      <RoleProjectPlugins
        groups={groups}
        layout="single-role"
        singleRoleId="r1"
        onUninstall={vi.fn().mockResolvedValue(undefined)}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        operatingKey={null}
      />,
    );

    expect(screen.getByText("dev-workflow")).toBeInTheDocument();
    expect(screen.queryByText("review-helper")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Engineer" })).not.toBeInTheDocument();
  });

  it("shows a single-role empty state when nothing matches", () => {
    render(
      <RoleProjectPlugins
        groups={groups}
        layout="single-role"
        singleRoleId="missing"
        onUninstall={vi.fn().mockResolvedValue(undefined)}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        operatingKey={null}
      />,
    );

    expect(screen.getByText("This Role uses the user-scope defaults")).toBeInTheDocument();
  });

  it("shows a full-layout empty state when there are no groups", () => {
    render(
      <RoleProjectPlugins
        groups={[]}
        layout="full"
        onUninstall={vi.fn().mockResolvedValue(undefined)}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        operatingKey={null}
      />,
    );

    expect(screen.getByText("All Roles use the user-scope defaults")).toBeInTheDocument();
  });

  it("calls onUninstall and onUpdate with the role workspace", () => {
    const onUninstall = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <RoleProjectPlugins
        groups={groups}
        layout="full"
        onUninstall={onUninstall}
        onUpdate={onUpdate}
        operatingKey={null}
      />,
    );

    const engineerSection = screen.getByRole("heading", { name: "Engineer" }).closest("section");
    if (!engineerSection) throw new Error("Engineer section missing");

    fireEvent.click(within(engineerSection).getByRole("button", { name: "Update" }));
    fireEvent.click(within(engineerSection).getByRole("button", { name: "Uninstall" }));

    expect(onUpdate).toHaveBeenCalledWith("dev-workflow@indie", "/work/engineer");
    expect(onUninstall).toHaveBeenCalledWith("dev-workflow@indie", "/work/engineer");
  });

  it("disables buttons while the row is operating", () => {
    render(
      <RoleProjectPlugins
        groups={groups}
        layout="full"
        onUninstall={vi.fn().mockResolvedValue(undefined)}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        operatingKey="dev-workflow@indie:/work/engineer"
      />,
    );

    const engineerSection = screen.getByRole("heading", { name: "Engineer" }).closest("section");
    if (!engineerSection) throw new Error("Engineer section missing");

    expect(within(engineerSection).getByRole("button", { name: "Update" })).toBeDisabled();
    expect(within(engineerSection).getByRole("button", { name: "Uninstall" })).toBeDisabled();
  });
});
