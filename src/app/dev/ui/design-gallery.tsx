"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import {
  AlignLeft,
  Bold,
  ChevronDown,
  ChevronRight,
  FileText,
  Inbox,
  Italic,
  LayoutGrid,
  List,
  Mail,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
} from "lucide-react";
import { TAG_HUES, Z } from "@/lib/design-tokens";
import { AVATAR_SIZES } from "@/lib/avatars";
import { Badge, BADGE_TONES } from "@/components/ui/badge";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { Segmented } from "@/components/ui/segmented";
import { Stepper } from "@/components/ui/stepper";
import { RangeSlider, Slider } from "@/components/ui/slider";
import { DatePicker } from "@/components/ui/date-picker";
import { CalendarGrid } from "@/components/ui/calendar-grid";
import { Sheet, type SheetSide, type SheetSize } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { Tag } from "@/components/ui/tag";
import { Avatar, AvatarGroup } from "@/components/ui/avatar";
import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardMedia,
  CardTitle,
} from "@/components/ui/card";
import { Section } from "@/components/ui/section";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner, type SpinnerSize } from "@/components/ui/spinner";
import { Progress, ProgressRing, type ProgressTone } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Kbd, type KbdSize } from "@/components/ui/kbd";
import { ToastView, type ToastVariant } from "@/components/ui/toaster";
import {
  RouteProgressBar,
  completeProgress,
  startProgress,
} from "@/components/ui/route-progress";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { HIGH_CONTRAST_KEY } from "@/components/topbar/actions-menu";
import {
  GALLERY_SECTIONS,
  galleryCoveredFiles,
  type GallerySection,
  type GallerySectionId,
} from "./gallery-manifest";

/**
 * The internal design gallery.
 *
 * Renders every primitive in `src/components/ui/` (see `gallery-manifest.ts`)
 * in every documented state, on one screen, with the tokens each section uses
 * printed beneath its heading. Exists only for review: `page.tsx` calls
 * `notFound()` in production.
 *
 * Overlay demos that portal on first paint (`Select defaultOpen`) are gated on
 * `mounted` so the server and first client render agree — no hydration warning,
 * no console noise.
 */

/* ------------------------------------------------------------------------- *
 * Sample data (module scope so it is stable across renders)
 * ------------------------------------------------------------------------- */

const BUTTON_VARIANTS: ButtonVariant[] = [
  "primary",
  "secondary",
  "ghost",
  "subtle",
  "danger",
];
const BUTTON_TEXT_SIZES: ButtonSize[] = ["xs", "sm", "md", "lg"];
const SPINNER_SIZES: SpinnerSize[] = ["xs", "sm", "md", "lg"];
const PROGRESS_TONES: ProgressTone[] = ["accent", "success", "danger"];
const KBD_SIZES: KbdSize[] = ["xs", "sm", "md"];
const TOAST_VARIANTS: ToastVariant[] = [
  "default",
  "success",
  "error",
  "info",
  "warning",
  "undo",
];

const SELECT_OPTIONS: SelectOption[] = [
  { value: "inbox", label: "Inbox", group: "Spaces" },
  {
    value: "roadmap",
    label: "Roadmap",
    description: "Quarterly plan",
    group: "Spaces",
    tag: "blue",
  },
  { value: "design", label: "Design", group: "Teams", tag: "purple" },
  {
    value: "engineering",
    label: "Engineering",
    group: "Teams",
    tag: "green",
    disabled: true,
  },
  { value: "marketing", label: "Marketing", group: "Teams", tag: "orange" },
];

const AVATAR_USERS = [
  { id: "1", name: "Ada Lovelace" },
  { id: "2", name: "Grace Hopper" },
  { id: "3", name: "Alan Turing" },
  { id: "4", name: "Katherine Johnson" },
  { id: "5", name: "Barbara Liskov" },
  { id: "6", name: "Margaret Hamilton" },
];

/* ------------------------------------------------------------------------- *
 * Small layout helpers
 * ------------------------------------------------------------------------- */

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

const ROW = "flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-4";

/* ------------------------------------------------------------------------- *
 * Theme switcher — the same mechanism the app uses (next-themes class + the
 * `.high-contrast` root class + the persisted `noema:high-contrast` key).
 * ------------------------------------------------------------------------- */

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [highContrast, setHighContrast] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    try {
      setHighContrast(window.localStorage.getItem(HIGH_CONTRAST_KEY) === "1");
    } catch {
      // Storage unavailable (private mode): keep the in-memory default.
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("high-contrast", highContrast);
    try {
      window.localStorage.setItem(HIGH_CONTRAST_KEY, highContrast ? "1" : "0");
    } catch {
      // Ignore a storage write failure; the class above already applied.
    }
  }, [highContrast]);

  if (!mounted) {
    return (
      <span
        aria-hidden
        className="inline-block h-8 w-40 rounded-md border border-border"
      />
    );
  }

  const value = highContrast ? "contrast" : theme === "dark" ? "dark" : "light";

  const onChange = (next: string) => {
    if (next === "contrast") {
      setHighContrast(true);
      setTheme("light");
      return;
    }
    setHighContrast(false);
    setTheme(next);
  };

  return (
    <Segmented
      ariaLabel="Theme"
      size="sm"
      value={value}
      onValueChange={onChange}
      options={[
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "contrast", label: "High contrast" },
      ]}
    />
  );
}

function ReducedMotionNote() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <span className="max-w-[22rem] text-xs text-muted">
      prefers-reduced-motion:{" "}
      <span className="font-medium text-fg">
        {reduced ? "reduce" : "no-preference"}
      </span>{" "}
      — the token layer neutralises every animation when set.
    </span>
  );
}

/* ------------------------------------------------------------------------- *
 * Stateful overlay demos
 * ------------------------------------------------------------------------- */

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <div className="p-5">
          <h3 className="text-xl font-semibold tracking-heading">
            Dialog title
          </h3>
          <p className="mt-1 text-sm text-muted">
            Focus is trapped while open and returns to the trigger on close.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button>Confirm</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PopoverDemo() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent>
        <p className="text-sm text-fg">Popover body</p>
        <p className="mt-1 text-xs text-muted">
          Anchored, collision-aware, on `Z.popover`.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function DropdownDemo() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" rightIcon={<ChevronDown className="h-4 w-4" />}>
          Open menu
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => {}}>Edit</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => {}}>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked onCheckedChange={() => {}}>
          Show archived
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => {}}>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextMenuDemo() {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="grid h-24 w-56 place-items-center rounded-md border border-dashed border-border-strong text-sm text-muted">
          Right-click me
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => {}}>Cut</ContextMenuItem>
        <ContextMenuItem onSelect={() => {}}>Copy</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={() => {}}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SheetDemo() {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<SheetSide>("right");
  const [size, setSize] = useState<SheetSize>("md");

  const openWith = (nextSide: SheetSide, nextSize: SheetSize) => {
    setSide(nextSide);
    setSize(nextSize);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => openWith("right", "md")}>
          Open right
        </Button>
        <Button variant="secondary" onClick={() => openWith("left", "md")}>
          Open left
        </Button>
        <Button variant="secondary" onClick={() => openWith("bottom", "md")}>
          Open bottom
        </Button>
        <Button variant="secondary" onClick={() => openWith("right", "lg")}>
          Open right (lg)
        </Button>
      </div>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        side={side}
        size={size}
        title="Sheet title"
        description="Focus is trapped; Escape closes it."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Save</Button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          Body content in a scrollable region. Sizes: sm, md, lg, full.
        </p>
      </Sheet>
    </div>
  );
}

function ConfirmDemo() {
  const [basic, setBasic] = useState(false);
  const [danger, setDanger] = useState(false);
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" onClick={() => setBasic(true)}>
        Confirm (default)
      </Button>
      <Button variant="secondary" onClick={() => setDanger(true)}>
        Confirm (danger + phrase)
      </Button>
      <Button variant="secondary" onClick={() => setPending(true)}>
        Confirm (pending)
      </Button>
      <ConfirmDialog
        open={basic}
        onOpenChange={setBasic}
        title="Publish changes?"
        description="This publishes twelve blocks."
        confirmLabel="Publish"
        onConfirm={() => setBasic(false)}
      />
      <ConfirmDialog
        open={danger}
        onOpenChange={setDanger}
        tone="danger"
        title="Delete workspace"
        description="This cannot be undone."
        confirmLabel="Delete"
        confirmPhrase="DELETE"
        typed={typed}
        onTypedChange={setTyped}
        onConfirm={() => {
          setDanger(false);
          setTyped("");
        }}
      />
      <ConfirmDialog
        open={pending}
        onOpenChange={setPending}
        pending
        title="Working"
        description="A second submit is refused while pending."
        confirmLabel="Save"
        onConfirm={() => {}}
      />
      <ConfirmDialog
        mode="two-step"
        open={false}
        onOpenChange={() => {}}
        tone="danger"
        title="Two-step"
        armLabel="Delete"
        confirmLabel="Confirm delete"
        onConfirm={() => {}}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Section chrome
 * ------------------------------------------------------------------------- */

function GallerySection({
  section,
  children,
}: {
  section: GallerySection;
  children: ReactNode;
}) {
  return (
    <section id={section.id} className="flex scroll-mt-28 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
        <h2 className="text-xl font-semibold tracking-heading">
          {section.title}
        </h2>
        <code className="text-xs text-muted">
          {section.files.map((file) => `ui/${file}.tsx`).join("  ·  ")}
        </code>
      </div>
      <p className="text-xs leading-5 text-muted">
        {section.tokens.join("   ")}
      </p>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------------- *
 * The gallery
 * ------------------------------------------------------------------------- */

export function DesignGallery() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const primitiveCount = galleryCoveredFiles().length;

  const content: Record<GallerySectionId, ReactNode> = {
    button: (
      <>
        <Group label="Solid variants">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </Group>
        <Group label="Soft tone">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant} tone="soft">
              {variant}
            </Button>
          ))}
        </Group>
        <Group label="Sizes">
          {BUTTON_TEXT_SIZES.map((size) => (
            <Button key={size} size={size}>
              size {size}
            </Button>
          ))}
        </Group>
        <Group label="States">
          <Button>Idle</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            rightIcon={<ChevronRight className="h-4 w-4" />}
          >
            With icons
          </Button>
          <Button size="icon" aria-label="Icon only small">
            <Plus className="h-4 w-4" />
          </Button>
          <Button size="iconOnly" aria-label="Icon only medium">
            <Settings className="h-4 w-4" />
          </Button>
          <Button asChild>
            <a href="#button">As link</a>
          </Button>
        </Group>
      </>
    ),

    input: (
      <>
        <Group label="Input — sizes and chrome">
          {(["sm", "md", "lg"] as const).map((size) => (
            <div key={size} className="w-56">
              <Input size={size} placeholder={`Input ${size}`} />
            </div>
          ))}
        </Group>
        <Group label="Input — icons, clear, invalid, disabled">
          <div className="w-64">
            <Input leading={<Search className="h-4 w-4" />} placeholder="Search" />
          </div>
          <div className="w-56">
            <Input
              trailing={<span className="text-xs text-muted">USD</span>}
              placeholder="Amount"
            />
          </div>
          <div className="w-56">
            <Input clearable defaultValue="Clear me" />
          </div>
          <div className="w-56">
            <Input invalid defaultValue="bad@" aria-label="Invalid input" />
          </div>
          <div className="w-56">
            <Input disabled defaultValue="Disabled" aria-label="Disabled input" />
          </div>
        </Group>
        <Group label="Textarea">
          {(["sm", "md", "lg"] as const).map((size) => (
            <div key={size} className="w-64">
              <Textarea size={size} placeholder={`Textarea ${size}`} />
            </div>
          ))}
          <div className="w-64">
            <Textarea invalid defaultValue="Invalid value" aria-label="Invalid textarea" />
          </div>
        </Group>
        <Group label="Field — label, hint, error, required">
          <div className="w-64">
            <Field id="gallery-field-hint" label="Label" hint="Helpful hint">
              <Input placeholder="With a hint" />
            </Field>
          </div>
          <div className="w-64">
            <Field
              id="gallery-field-error"
              label="Email"
              required
              error="Enter a valid email address"
            >
              <Input defaultValue="not-an-email" />
            </Field>
          </div>
        </Group>
      </>
    ),

    select: (
      <>
        <Group label="Closed states">
          <div className="w-64">
            <Select options={SELECT_OPTIONS} placeholder="Single select" />
          </div>
          <div className="w-64">
            <Select options={SELECT_OPTIONS} defaultValue="roadmap" />
          </div>
          <div className="w-64">
            <Select
              options={SELECT_OPTIONS}
              multiple
              defaultValue={["inbox", "design"]}
              placeholder="Multi select"
            />
          </div>
          <div className="w-64">
            <Select options={SELECT_OPTIONS} disabled defaultValue="design" />
          </div>
          <div className="w-64">
            <Select
              options={SELECT_OPTIONS}
              invalid
              errorMessage="This field is required."
              placeholder="Error"
            />
          </div>
          <div className="w-64">
            <Select options={SELECT_OPTIONS} loading placeholder="Loading" />
          </div>
        </Group>
        <Group label="Open · empty">
          {mounted ? (
            <>
              <div className="w-64">
                <Select options={SELECT_OPTIONS} defaultOpen searchable={false} />
              </div>
              <div className="w-64">
                <Select options={[]} defaultOpen searchable={false} />
              </div>
              <Note>
                Open menus portal to the body, so they render after mount.
              </Note>
            </>
          ) : (
            <Note>Open menus render after mount.</Note>
          )}
        </Group>
      </>
    ),

    checkbox: (
      <>
        <Group label="States">
          <Checkbox checked={false} label="Unchecked" />
          <Checkbox checked label="Checked" />
          <Checkbox checked="indeterminate" label="Indeterminate" />
          <Checkbox
            checked={false}
            label="With description"
            description="A short supporting line"
          />
          <Checkbox
            checked={false}
            label="Error"
            error="This field is required."
          />
          <Checkbox checked disabled label="Disabled" />
        </Group>
        <Group label="Sizes">
          <Checkbox checked size="sm" label="sm" />
          <Checkbox checked size="md" label="md" />
        </Group>
      </>
    ),

    switch: (
      <>
        <Group label="States">
          <Switch checked={false} label="Off" />
          <Switch checked label="On" />
          <Switch
            checked
            pending
            label="Pending"
            description="Optimistic, marked busy"
          />
          <Switch checked disabled label="Disabled" />
        </Group>
        <Group label="Sizes">
          <Switch checked size="sm" label="sm" />
          <Switch checked size="md" label="md" />
        </Group>
      </>
    ),

    radio: (
      <>
        <Group label="Vertical">
          <RadioGroup defaultValue="daily" name="gallery-radio-v">
            <Radio value="daily" label="Daily" description="Once a day" />
            <Radio value="weekly" label="Weekly" />
            <Radio value="monthly" label="Monthly" />
            <Radio value="never" label="Never" disabled />
          </RadioGroup>
        </Group>
        <Group label="Horizontal">
          <RadioGroup
            defaultValue="left"
            orientation="horizontal"
            name="gallery-radio-h"
          >
            <Radio value="left" label="Left" />
            <Radio value="center" label="Center" />
            <Radio value="right" label="Right" />
          </RadioGroup>
        </Group>
        <Group label="Sizes">
          <RadioGroup defaultValue="a" size="sm" name="gallery-radio-sm">
            <Radio value="a" label="sm a" />
            <Radio value="b" label="sm b" />
          </RadioGroup>
          <RadioGroup defaultValue="a" size="md" name="gallery-radio-md">
            <Radio value="a" label="md a" />
            <Radio value="b" label="md b" />
          </RadioGroup>
        </Group>
      </>
    ),

    segmented: (
      <>
        <Group label="Sizes">
          <Segmented
            ariaLabel="View (md)"
            options={[
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
              { value: "table", label: "Table" },
            ]}
          />
          <Segmented
            ariaLabel="View (sm)"
            size="sm"
            defaultValue="list"
            options={[
              {
                value: "list",
                label: "List",
                icon: <List className="h-3.5 w-3.5" />,
              },
              {
                value: "board",
                label: "Board",
                icon: <LayoutGrid className="h-3.5 w-3.5" />,
              },
            ]}
          />
        </Group>
        <Group label="Disabled">
          <Segmented
            ariaLabel="Views (disabled)"
            disabled
            options={[
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
            ]}
          />
          <Segmented
            ariaLabel="Views (one disabled)"
            defaultValue="table"
            options={[
              { value: "list", label: "List" },
              { value: "board", label: "Board", disabled: true },
              { value: "table", label: "Table" },
            ]}
          />
        </Group>
      </>
    ),

    stepper: (
      <Group label="States and units">
        <div className="w-64">
          <Stepper defaultValue={3} min={0} max={10} label="Quantity" />
        </div>
        <div className="w-64">
          <Stepper defaultValue={42} min={0} max={100} unit="px" />
        </div>
        <div className="w-64">
          <Stepper
            invalid
            defaultValue={120}
            min={0}
            max={100}
            errorMessage="Enter a value within the allowed range."
          />
        </div>
        <div className="w-64">
          <Stepper disabled defaultValue={5} label="Disabled" />
        </div>
      </Group>
    ),

    slider: (
      <>
        <Group label="Slider">
          <div className="w-64">
            <Slider defaultValue={40} label="Opacity" showBubble />
          </div>
          <div className="w-64">
            <Slider
              defaultValue={3}
              min={0}
              max={10}
              step={1}
              showTicks
              label="Ticks"
            />
          </div>
          <div className="w-64">
            <Slider defaultValue={50} disabled label="Disabled" />
          </div>
        </Group>
        <Group label="Range slider">
          <div className="w-72">
            <RangeSlider defaultValue={[20, 80]} label="Range" showBubble showTicks />
          </div>
          <div className="w-72">
            <RangeSlider defaultValue={[10, 40]} disabled label="Disabled range" />
          </div>
        </Group>
      </>
    ),

    "date-picker": (
      <>
        <Group label="Pick modes">
          <DatePicker mode="date" />
          <DatePicker mode="range" />
          <DatePicker mode="time" />
          <DatePicker mode="datetime" />
        </Group>
        <Group label="Calendar grid">
          <div className="rounded-md border border-border bg-bg p-3">
            <CalendarGrid
              year={2026}
              month={2}
              today="2026-03-15"
              value={{ start: "2026-03-10", end: "2026-03-14" }}
              onSelectDay={() => {}}
              onHoverDay={() => {}}
              onShiftMonth={() => {}}
            />
          </div>
        </Group>
      </>
    ),

    sheet: <SheetDemo />,

    "confirm-dialog": <ConfirmDemo />,

    overlays: (
      <>
        <Group label="Dialog · Popover · Dropdown · Context menu">
          <DialogDemo />
          <PopoverDemo />
          <DropdownDemo />
          <ContextMenuDemo />
        </Group>
      </>
    ),

    tooltip: (
      <Group label="Tooltip">
        <Tooltip label="Bold">
          <Button size="iconOnly" variant="ghost" aria-label="Bold">
            <Bold className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip label="Italic">
          <Button size="iconOnly" variant="ghost" aria-label="Italic">
            <Italic className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip label="Align left" side="top">
          <Button size="iconOnly" variant="ghost" aria-label="Align left">
            <AlignLeft className="h-4 w-4" />
          </Button>
        </Tooltip>
      </Group>
    ),

    tag: (
      <>
        <Group label="Ten hues · md">
          {TAG_HUES.map((hue) => (
            <Tag key={hue} hue={hue} size="md">
              {hue}
            </Tag>
          ))}
        </Group>
        <Group label="Ten hues · sm · dot">
          {TAG_HUES.map((hue) => (
            <Tag key={hue} hue={hue} size="sm" dot>
              {hue}
            </Tag>
          ))}
        </Group>
        <Group label="Closable · selectable · disabled">
          <Tag hue="blue" closable onClose={() => {}}>
            Closable
          </Tag>
          <Tag hue="green" dot selected onSelectedChange={() => {}}>
            Selected
          </Tag>
          <Tag hue="orange" onSelectedChange={() => {}}>
            Selectable
          </Tag>
          <Tag hue="red" pendingRemoval onUndo={() => {}}>
            Pending removal
          </Tag>
          <Tag hue="gray" disabled>
            Disabled
          </Tag>
        </Group>
      </>
    ),

    badge: (
      <>
        <Group label="Tones">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </Group>
        <Group label="Sizes, counts, icons">
          <Badge size="sm">sm</Badge>
          <Badge size="md">md</Badge>
          <Badge count={7} />
          <Badge count={128} max={99} />
          <Badge tone="accent" icon={<Star className="h-3 w-3" />}>
            New
          </Badge>
        </Group>
      </>
    ),

    avatar: (
      <>
        <Group label="Sizes">
          {AVATAR_SIZES.map((size) => (
            <Avatar key={size} user={AVATAR_USERS[0]} size={size} />
          ))}
        </Group>
        <Group label="Presence">
          <Avatar user={AVATAR_USERS[1]} status="online" />
          <Avatar user={AVATAR_USERS[2]} status="away" />
          <Avatar user={AVATAR_USERS[3]} status="busy" />
        </Group>
        <Group label="Group with +N overflow">
          <AvatarGroup users={AVATAR_USERS} max={4} />
        </Group>
      </>
    ),

    card: (
      <>
        <Group label="Variants">
          <Card variant="raised" className="w-56">
            <CardTitle>Raised</CardTitle>
          </Card>
          <Card variant="flat" className="w-56">
            <CardTitle>Flat</CardTitle>
          </Card>
          <Card variant="interactive" className="w-56">
            <CardTitle>Interactive</CardTitle>
          </Card>
        </Group>
        <Group label="Paddings">
          {(["none", "sm", "md", "lg"] as const).map((padding) => (
            <Card key={padding} variant="flat" padding={padding} className="w-40">
              <span className="text-sm">padding {padding}</span>
            </Card>
          ))}
        </Group>
        <Group label="Composed">
          <Card variant="raised" padding="none" className="w-72 overflow-hidden">
            <CardMedia aspect="video" className="grid place-items-center text-muted">
              <FileText className="h-6 w-6" />
            </CardMedia>
            <div className="p-4">
              <CardHeader
                icon={<Sparkles className="h-4 w-4" />}
                title="Quarterly roadmap"
                subtitle="Updated today"
                actions={<Badge tone="accent">Draft</Badge>}
              />
              <CardBody className="mt-2 text-muted">
                Cards compose a header, a body and a footer action row.
              </CardBody>
              <CardFooter className="mt-3">
                <Button size="sm" variant="secondary">
                  Open
                </Button>
              </CardFooter>
            </div>
          </Card>
        </Group>
      </>
    ),

    section: (
      <>
        <Section
          title="Default section"
          description="The one settings-page block: heading, description, action slot."
          action={<Button size="sm" variant="secondary">Reset</Button>}
        >
          <div className={ROW}>
            <span className="text-sm text-muted">Section body</span>
          </div>
        </Section>
        <Section
          title="Danger section"
          description="A destructive block re-colours the heading only."
          tone="danger"
          level={3}
        >
          <div className={ROW}>
            <span className="text-sm text-muted">Destructive content</span>
          </div>
        </Section>
      </>
    ),

    "empty-state": (
      <>
        <Group label="Full">
          <div className="w-full">
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title="No messages"
              description="Nothing matches this filter."
              primaryAction={<Button>New message</Button>}
              secondaryAction={
                <Button variant="secondary">Clear filter</Button>
              }
              tip="Press"
              shortcut="C"
            />
          </div>
        </Group>
        <Group label="Compact">
          <div className="w-72 rounded-md border border-border">
            <EmptyState
              variant="compact"
              icon={<Mail className="h-4 w-4" />}
              title="No results"
              description="Try a different search."
              primaryAction={
                <Button size="sm" variant="secondary">
                  Clear
                </Button>
              }
            />
          </div>
        </Group>
      </>
    ),

    skeleton: (
      <>
        <Group label="Text">
          <div className="w-56">
            <Skeleton variant="text" lines={1} />
          </div>
          <div className="w-56">
            <Skeleton variant="text" lines={3} />
          </div>
        </Group>
        <Group label="Block · circle">
          <Skeleton variant="block" width={160} />
          <Skeleton variant="circle" width={40} />
        </Group>
        <Group label="Card">
          <div className="w-72">
            <Skeleton variant="card" />
          </div>
        </Group>
        <Group label="Row">
          <div className="w-72">
            <Skeleton variant="row" />
          </div>
        </Group>
        <Group label="Table">
          <div className="w-full max-w-xl">
            <Skeleton variant="table" rows={3} cols={4} />
          </div>
        </Group>
      </>
    ),

    spinner: (
      <Group label="Sizes and label">
        {SPINNER_SIZES.map((size) => (
          <span key={size} className="text-accent">
            <Spinner size={size} />
          </span>
        ))}
        <Spinner size="md" label="Loading" className="text-muted" />
      </Group>
    ),

    progress: (
      <>
        <Group label="Bars">
          <div className="w-64">
            <Progress value={32} label="Uploading" showValue />
          </div>
          <div className="w-64">
            <Progress value={64} tone="success" size="md" showValue />
          </div>
          <div className="w-64">
            <Progress value={18} tone="danger" size="lg" />
          </div>
          <div className="w-64">
            <Progress size="xs" label="Indeterminate" />
          </div>
        </Group>
        <Group label="Rings">
          <ProgressRing value={72} showValue />
          <ProgressRing value={100} tone="success" />
          <ProgressRing value={25} tone="danger" />
          <ProgressRing label="Working" />
        </Group>
        <Group label="Tones">
          {PROGRESS_TONES.map((tone) => (
            <span key={tone} className="flex items-center gap-2">
              <span className="w-24 text-xs text-muted">{tone}</span>
              <ProgressRing value={50} tone={tone} />
            </span>
          ))}
        </Group>
      </>
    ),

    "scroll-area": (
      <>
        <Group label="Vertical">
          <ScrollArea maxHeight={160} className="w-64 rounded-md border border-border">
            <div className="flex flex-col gap-1 p-2">
              {Array.from({ length: 16 }).map((_, index) => (
                <div
                  key={index}
                  className="rounded-sm bg-surface-2 px-2 py-1 text-sm"
                >
                  Row {index + 1}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Group>
        <Group label="Horizontal">
          <ScrollArea orientation="horizontal" fade="bottom" className="w-full">
            <div className="flex gap-2 pb-1">
              {Array.from({ length: 20 }).map((_, index) => (
                <div
                  key={index}
                  className="shrink-0 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm"
                >
                  Item {index + 1}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Group>
      </>
    ),

    separator: (
      <>
        <Group label="Horizontal">
          <div className="w-72">
            <Separator />
          </div>
          <div className="w-72">
            <Separator variant="hairline" />
          </div>
          <div className="w-72">
            <Separator label="or" />
          </div>
        </Group>
        <Group label="Vertical">
          <div className="flex h-16 items-center gap-4">
            <span className="text-sm text-muted">A</span>
            <Separator orientation="vertical" />
            <span className="text-sm text-muted">B</span>
            <Separator orientation="vertical" variant="hairline" />
            <span className="text-sm text-muted">C</span>
          </div>
        </Group>
      </>
    ),

    kbd: (
      <>
        <Group label="Sizes">
          {KBD_SIZES.map((size) => (
            <Kbd key={size} size={size}>
              Esc
            </Kbd>
          ))}
        </Group>
        <Group label="Key groups">
          <Kbd>Ctrl K</Kbd>
          <Kbd keys={["Cmd", "Shift", "P"]} />
        </Group>
      </>
    ),

    toaster: (
      <>
        <Group label="Variants">
          {TOAST_VARIANTS.map((variant) => (
            <ToastView
              key={variant}
              variant={variant}
              title={`${variant} toast`}
              description="Toast body"
            />
          ))}
        </Group>
        <Group label="Action">
          <ToastView
            variant="undo"
            title="Note deleted"
            actionLabel="Undo"
            onAction={() => {}}
          />
        </Group>
        <Note>
          The live `Toaster` is mounted once by the root layout; these are the
          presentational surfaces it renders.
        </Note>
      </>
    ),

    "route-progress": (
      <>
        <Group label="Phases">
          <div className="w-full">
            <RouteProgressBar state={startProgress()} />
          </div>
          <div className="w-full">
            <RouteProgressBar state={completeProgress(startProgress())} />
          </div>
          <div className="w-full">
            <RouteProgressBar state={completeProgress(startProgress())} reducedMotion />
          </div>
        </Group>
        <Note>
          A 2px accent bar pinned to the viewport top; never blocks input.
        </Note>
      </>
    ),

    "emoji-picker": (
      <Group label="Picker">
        <EmojiPicker locale="en" onSelect={() => {}} />
        <span className="text-sm text-muted">
          Frecency-ranked, persisted per user.
        </span>
      </Group>
    ),
  };

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header
        className="sticky top-0 border-b border-border bg-bg"
        style={{ zIndex: Z.sticky }}
      >
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-8 py-3">
          <h1 className="text-sm font-semibold">Design system gallery</h1>
          <span className="text-xs text-muted">
            {primitiveCount} primitives · {GALLERY_SECTIONS.length} sections ·
            development only
          </span>
          <div className="ms-auto flex flex-wrap items-center gap-3">
            <ReducedMotionNote />
            <ThemeSwitcher />
          </div>
        </div>
        <ScrollArea
          orientation="horizontal"
          fade="bottom"
          className="border-t border-border"
        >
          <nav className="flex gap-1 px-8 py-2">
            {GALLERY_SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="focus-ring shrink-0 rounded-sm px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
              >
                {section.title}
              </a>
            ))}
          </nav>
        </ScrollArea>
      </header>

      <main className="mx-auto flex max-w-[1600px] flex-col gap-12 px-8 py-12">
        {GALLERY_SECTIONS.map((section) => (
          <GallerySection key={section.id} section={section}>
            {content[section.id]}
          </GallerySection>
        ))}
      </main>

      <footer className="border-t border-border px-8 py-6 text-xs text-muted">
        Internal surface — `NODE_ENV=production` calls `notFound()`. Coverage is
        pinned by `gallery.test.ts`.
      </footer>
    </div>
  );
}
