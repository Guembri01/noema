import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { prisma } from "@/lib/db";
import {
  buildBillingViewModel,
  formatPlanAmount,
  readWorkspacePlan,
  type BillingUsage,
  type PlanProrationPreview,
} from "@/lib/workspace-plan";
import { t } from "@/lib/i18n";

export const metadata = { title: "Plan & billing" };

/** The current UTC calendar month, `[start, end)`, for the proration preview. */
function utcMonth(at: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

/** Whole-currency rendering for the display-only proration amounts. */
function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function shortDate(value: Date): string {
  return `${MONTH_NAMES[value.getUTCMonth()]} ${value.getUTCDate()}`;
}

/** `used / limit` meter with an over-limit-safe reading. */
function usageText(usage: BillingUsage): string {
  return `${usage.used} / ${formatPlanAmount(usage.limit)}`;
}

/**
 * Plan & billing settings — the reachable surface for the pure `@/lib/plans`
 * engine. It renders the workspace's current plan, its numeric ceilings and
 * unlocked features (via `buildBillingViewModel`, i.e. `getPlanLimits` /
 * `describePlan`), the seat and guest meters (`canAddSeats` / `withinLimit`) and
 * a proration preview for every other tier (`proratePlanChange`).
 *
 * Read-only by design: the repo ships no payment provider (spec D2 / R26.16),
 * so this page shows state and never offers a purchase. The current plan comes
 * from {@link readWorkspacePlan}; see `@/lib/workspace-plan` for why that is an
 * environment field rather than a `Workspace` column today.
 */
export default async function BillingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const [seatCount, guestCount] = await Promise.all([
    prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
    prisma.workspaceMember.count({ where: { workspaceId: workspace.id, role: "GUEST" } }),
  ]);

  const at = new Date();
  const { start, end } = utcMonth(at);
  const model = buildBillingViewModel({
    plan: readWorkspacePlan(),
    seatCount,
    guestCount,
    periodStart: start,
    periodEnd: end,
    at,
  });

  return (
    <div className="mx-auto max-w-2xl px-10 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">Plan &amp; billing</h1>
      <p className="mb-8 text-sm text-muted">
        The plan this workspace runs under, the limits it enforces and what an upgrade would cost.
        This deployment processes no payments — every amount below is a preview only.
      </p>

      <section className="mb-10" aria-labelledby="current-plan-heading">
        <h2
          id="current-plan-heading"
          className="mb-3 text-sm font-medium uppercase tracking-wide text-muted"
        >
          Current plan
        </h2>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-lg font-semibold">{model.label}</span>
            <span className="text-xs uppercase tracking-wide text-muted">{model.plan}</span>
          </div>
          {!model.known && (
            <p className="mt-2 text-xs text-muted">
              The configured plan is unrecognised, so the workspace fails closed to the Free tier.
            </p>
          )}
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Member seats</dt>
              <dd className="text-sm">
                {usageText(model.seats)}{" "}
                <span className={model.seats.canAdd ? "text-muted" : "text-accent"}>
                  · {model.seats.canAdd ? "room to add" : "at the ceiling"}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">External guests</dt>
              <dd className="text-sm">
                {usageText(model.guests)}{" "}
                <span className={model.guests.canAdd ? "text-muted" : "text-accent"}>
                  · {model.guests.canAdd ? "room to invite" : "at the ceiling"}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="mb-10" aria-labelledby="limits-heading">
        <h2
          id="limits-heading"
          className="mb-3 text-sm font-medium uppercase tracking-wide text-muted"
        >
          Limits
        </h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border border-y border-border">
            {model.limits.map((row) => (
              <tr key={row.kind}>
                <th scope="row" className="py-2 text-left font-normal text-muted">
                  {row.label}
                </th>
                <td className="py-2 text-right tabular-nums">{formatPlanAmount(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-10" aria-labelledby="features-heading">
        <h2
          id="features-heading"
          className="mb-3 text-sm font-medium uppercase tracking-wide text-muted"
        >
          Gated features
        </h2>
        {model.features.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {model.features.map((feature) => (
              <li
                key={feature}
                className="rounded-full border border-border px-3 py-1 text-xs capitalize"
              >
                {feature}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            No gated features on this plan. SSO, SCIM, the extended audit log and custom roles
            unlock on higher tiers.
          </p>
        )}
      </section>

      <section aria-labelledby="proration-heading">
        <h2
          id="proration-heading"
          className="mb-3 text-sm font-medium uppercase tracking-wide text-muted"
        >
          Plan change preview
        </h2>
        <p className="mb-3 text-xs text-muted">
          Prorated at the current date for the period {shortDate(start)} – {shortDate(end)}. A
          positive amount would be billed; a negative amount is credit owed to the workspace.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Plan</th>
              <th className="pb-2 font-medium">Change</th>
              <th className="hidden pb-2 text-right font-medium tabular-nums sm:table-cell">
                Period left
              </th>
              <th className="pb-2 text-right font-medium tabular-nums">Amount due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {model.proration.map((preview) => (
              <ProrationRow key={preview.to} preview={preview} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** One proration preview row; direction drives the badge color. */
function ProrationRow({ preview }: { preview: PlanProrationPreview }) {
  const badgeClass =
    preview.direction === "upgrade"
      ? "text-accent"
      : preview.direction === "downgrade"
        ? "text-muted"
        : "text-muted";
  return (
    <tr>
      <td className="py-2">{preview.label}</td>
      <td className={`py-2 capitalize ${badgeClass}`}>{preview.direction}</td>
      <td className="hidden py-2 text-right tabular-nums sm:table-cell">
        {Math.round(preview.fractionRemaining * 100)}%
      </td>
      <td className="py-2 text-right tabular-nums">{money(preview.amountDue)}</td>
    </tr>
  );
}
