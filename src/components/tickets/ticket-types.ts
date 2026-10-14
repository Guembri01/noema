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
  blue: "bg-blue-500/10 text-blue-600",
  green: "bg-emerald-500/10 text-emerald-600",
  yellow: "bg-amber-500/10 text-amber-600",
  orange: "bg-orange-500/10 text-orange-600",
  red: "bg-red-500/10 text-red-500",
  purple: "bg-purple-500/10 text-purple-600",
  pink: "bg-pink-500/10 text-pink-600",
};
