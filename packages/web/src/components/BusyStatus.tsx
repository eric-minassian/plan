import type { ReactNode } from "react";
import { BusyIcon } from "./BusyIcon.tsx";

/** Standalone loading row: polite status region + decorative spinner. */
export function BusyStatus(props: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="status"
      className={
        props.className ??
        "flex items-center gap-2 text-sm text-muted-foreground"
      }
    >
      <BusyIcon />
      {props.children}
    </div>
  );
}
