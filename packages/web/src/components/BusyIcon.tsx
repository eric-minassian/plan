import { Loader2Icon } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * Decorative busy indicator. Use next to visible busy text so AT does not
 * also hear the design Spinner's role="status" / aria-label="Loading".
 */
export function BusyIcon(
  props: Omit<ComponentProps<typeof Loader2Icon>, "aria-hidden">,
) {
  const { className, ...rest } = props;
  return (
    <Loader2Icon
      aria-hidden
      className={
        className !== undefined
          ? `size-3.5 shrink-0 animate-spin ${className}`
          : "size-3.5 shrink-0 animate-spin"
      }
      {...rest}
    />
  );
}
