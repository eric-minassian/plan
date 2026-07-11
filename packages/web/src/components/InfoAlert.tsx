import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Non-assertive status banner. Do not use design `Alert` here — that component
 * hardcodes `role="alert"`, which is too aggressive for informational copy.
 */
export function InfoAlert(props: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="relative grid w-full grid-cols-[auto_1fr] gap-x-1.5 gap-y-0.5 rounded-lg border bg-card px-2 py-1.5 text-left text-xs/relaxed text-card-foreground"
    >
      <InfoIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="text-xs/relaxed text-muted-foreground md:text-pretty">
        {props.children}
      </div>
    </div>
  );
}
