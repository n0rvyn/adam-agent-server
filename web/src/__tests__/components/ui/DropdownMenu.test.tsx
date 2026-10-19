import { describe, it, expect } from "vitest";
import { render, screen } from "../../utils/test-utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/DropdownMenu";
import { Button } from "@/components/ui/Button";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("DropdownMenu", () => {
  it("renders trigger button", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Open</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });
});

describe("DropdownMenu animation classes (source verification)", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../components/ui/DropdownMenu.tsx"),
    "utf-8",
  );

  it("Content has directional slide-in classes", () => {
    expect(source).toContain("data-[side=bottom]:slide-in-from-top-2");
    expect(source).toContain("data-[side=left]:slide-in-from-right-2");
    expect(source).toContain("data-[side=right]:slide-in-from-left-2");
    expect(source).toContain("data-[side=top]:slide-in-from-bottom-2");
  });

  it("SubContent also has directional slide-in classes", () => {
    const matches = (source.match(/slide-in-from-top-2/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });
});
