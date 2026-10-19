import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "../../utils/test-utils";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption,
  Thead, Tbody, Tr, Th, Td,
} from "@/components/ui/Table";

describe("Table", () => {
  it("renders with overflow wrapper", () => {
    render(
      <Table data-testid="table">
        <TableBody>
          <TableRow><TableCell>Cell</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    const table = screen.getByTestId("table");
    expect(table.tagName).toBe("TABLE");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });

  it("renders TableHeader as thead", () => {
    render(
      <Table>
        <TableHeader data-testid="thead">
          <TableRow><TableHead>H</TableHead></TableRow>
        </TableHeader>
        <TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody>
      </Table>,
    );
    expect(screen.getByTestId("thead").tagName).toBe("THEAD");
    expect(screen.getByTestId("thead").className).toContain("border-[var(--app-border)]");
  });

  it("renders TableBody as tbody with dividers", () => {
    render(
      <Table>
        <TableBody data-testid="tbody">
          <TableRow><TableCell>C</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByTestId("tbody").tagName).toBe("TBODY");
    expect(screen.getByTestId("tbody").className).toContain("divide-y");
  });

  it("renders TableRow with hover style", () => {
    render(
      <Table><TableBody>
        <TableRow data-testid="row"><TableCell>C</TableCell></TableRow>
      </TableBody></Table>,
    );
    expect(screen.getByTestId("row").className).toContain("hover:bg-white/[0.04]");
  });

  it("renders TableHead as th", () => {
    render(
      <Table><TableHeader>
        <TableRow><TableHead>Header</TableHead></TableRow>
      </TableHeader><TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody></Table>,
    );
    expect(screen.getByText("Header").tagName).toBe("TH");
  });

  it("renders TableCell as td", () => {
    render(
      <Table><TableBody>
        <TableRow><TableCell>Data</TableCell></TableRow>
      </TableBody></Table>,
    );
    expect(screen.getByText("Data").tagName).toBe("TD");
  });

  it("renders TableCaption", () => {
    render(
      <Table>
        <TableCaption>Caption text</TableCaption>
        <TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody>
      </Table>,
    );
    expect(screen.getByText("Caption text").tagName).toBe("CAPTION");
  });
});

describe("forwardRef", () => {
  it("Table forwards ref to table element", () => {
    const ref = createRef<HTMLTableElement>();
    render(
      <Table ref={ref}><TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody></Table>,
    );
    expect(ref.current).toBeInstanceOf(HTMLTableElement);
  });
});

describe("className merge", () => {
  it("Table merges custom className", () => {
    render(
      <Table data-testid="t" className="custom">
        <TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody>
      </Table>,
    );
    expect(screen.getByTestId("t").className).toContain("custom");
  });

  it("TableRow merges custom className", () => {
    render(
      <Table><TableBody>
        <TableRow data-testid="row" className="custom"><TableCell>C</TableCell></TableRow>
      </TableBody></Table>,
    );
    const row = screen.getByTestId("row");
    expect(row.className).toContain("custom");
    expect(row.className).toContain("hover:bg-white/[0.04]");
  });

  it("TableCell merges custom className", () => {
    render(
      <Table><TableBody>
        <TableRow><TableCell className="custom">C</TableCell></TableRow>
      </TableBody></Table>,
    );
    const cell = screen.getByText("C");
    expect(cell.className).toContain("custom");
    expect(cell.className).toContain("text-[var(--app-text)]");
  });
});

describe("compatibility exports", () => {
  it("Thead is TableHeader", () => { expect(Thead).toBe(TableHeader); });
  it("Tbody is TableBody", () => { expect(Tbody).toBe(TableBody); });
  it("Tr is TableRow", () => { expect(Tr).toBe(TableRow); });
  it("Th is TableHead", () => { expect(Th).toBe(TableHead); });
  it("Td is TableCell", () => { expect(Td).toBe(TableCell); });
});
