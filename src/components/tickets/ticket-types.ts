export type TicketRow = {
  id: string;
  key: string;
  title: string;
  /** Plain-text description (sanitised), empty string when none. */
  description: string;
  type: string;
  status: string;
  priority: string;
  estimate: number | null;
  estimateUnit: string | null;
  startDate: string | null;
  dueDate: string | null;
  parentId: string | null;
  cycleId: string | null;
  projectId: string | null;
  projectName: string | null;
  milestoneName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  labels: { id: string; name: string; color: string }[];
  labelIds: string[];
  commentCount: number;
  childCount: number;
};

export type LabelRow = { id: string; name: string; color: string; count: number };

export const LABEL_TONES: Record<string, string> = {
  gray: "bg-surface-2 text-muted",
  blue: "bg-[var(--tag-blue-bg)] text-[var(--tag-blue-fg)]",
  green: "bg-[var(--tag-green-bg)] text-[var(--tag-green-fg)]",
  yellow: "bg-[var(--tag-yellow-bg)] text-[var(--tag-yellow-fg)]",
  orange: "bg-[var(--tag-orange-bg)] text-[var(--tag-orange-fg)]",
  red: "bg-[var(--tag-red-bg)] text-[var(--tag-red-fg)]",
  purple: "bg-[var(--tag-purple-bg)] text-[var(--tag-purple-fg)]",
  pink: "bg-[var(--tag-pink-bg)] text-[var(--tag-pink-fg)]",
};
