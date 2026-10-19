// Icon scale - keep in sync with .claude/reviews/icon-audit-2026-04-13.md
// xs: chip/badge/table-row action | sm: Button size="sm", inline text-sm
// md: Button default (mirrors [&_svg]:size-4), StatCard, sidebar
// lg: mobile chrome toggle, modal close, 40x40 tile decorator
// hero: EmptyState icon prop only
export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  hero: 32,
} as const;

export type IconSize = (typeof ICON_SIZE)[keyof typeof ICON_SIZE];
