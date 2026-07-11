import { Button } from "@eric-minassian/design/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@eric-minassian/design/components/card";
import {
  Field,
  FieldLabel,
} from "@eric-minassian/design/components/field";
import { Input } from "@eric-minassian/design/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@eric-minassian/design/components/item";
import { BusyIcon } from "./BusyIcon.tsx";
import type {
  CreateShareResponse,
  ShareGrantPublic,
} from "@tripplan/domain";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TripPlanApi } from "../api/client.ts";
import { formatApiError } from "../api/errors.ts";
import { ErrorAlert } from "./ErrorAlert.tsx";

export interface SharePanelProps {
  readonly tripId: string;
  readonly api: TripPlanApi;
}

function buildShareUrl(path: string, token: string): string {
  return `${window.location.origin}${path}#${token}`;
}

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

/** Owner share management: create link, copy, list, revoke. */
export function SharePanel(props: SharePanelProps) {
  const { tripId, api } = props;
  const [shares, setShares] = useState<readonly ShareGrantPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined);
  const [lastCreated, setLastCreated] = useState<
    | { readonly url: string; readonly shareId: string; readonly label: string }
    | undefined
  >(undefined);
  const [copied, setCopied] = useState(false);

  const loadShares = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.listShares(tripId);
      setShares(result.shares);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setLoading(false);
    }
  }, [api, tripId]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  async function handleCreate(): Promise<void> {
    setCreating(true);
    setError(undefined);
    setCopied(false);
    try {
      const trimmed = label.trim();
      const created: CreateShareResponse = await api.createShare(
        tripId,
        trimmed.length > 0 ? { label: trimmed } : {},
      );
      const url = buildShareUrl(created.path, created.token);
      setLastCreated({
        url,
        shareId: created.shareId,
        label: created.label,
      });
      setLabel("");
      await loadShares();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(
        "Could not copy to clipboard — select the link and copy manually.",
      );
    }
  }

  async function handleRevoke(share: ShareGrantPublic): Promise<void> {
    const ok = window.confirm(
      `Revoke share${share.label.length > 0 ? ` “${share.label}”` : ""}? Viewers with this link will lose access immediately.`,
    );
    if (!ok) {
      return;
    }
    setRevokingId(share.shareId);
    setError(undefined);
    try {
      await api.revokeShare(tripId, share.shareId);
      if (lastCreated?.shareId === share.shareId) {
        setLastCreated(undefined);
      }
      await loadShares();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setRevokingId(undefined);
    }
  }

  const active = shares.filter((s) => !s.revoked);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Share</CardTitle>
        <CardDescription>
          Anyone with the link can view the{" "}
          <strong className="font-medium text-foreground">
            full itinerary
          </strong>{" "}
          (titles, times, notes, confirmation codes, locations) until the link
          expires or you revoke it. No account required.{" "}
          <strong className="font-medium text-foreground">
            Opening another shared trip in this browser switches the active
            share view
          </strong>{" "}
          (one share session cookie at a time).
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void loadShares();
            }}
            disabled={loading}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={loading ? "animate-spin" : undefined}
            />
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== undefined ? <ErrorAlert>{error}</ErrorAlert> : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="flex-1">
            <FieldLabel htmlFor="share-label">Label (optional)</FieldLabel>
            <Input
              id="share-label"
              type="text"
              maxLength={80}
              value={label}
              placeholder="Family, Friends…"
              onChange={(e) => {
                setLabel(e.target.value);
              }}
              disabled={creating}
            />
          </Field>
          <Button
            type="button"
            disabled={creating}
            onClick={() => {
              void handleCreate();
            }}
          >
            {creating ? (
              <>
                <BusyIcon data-icon="inline-start" />
                Creating…
              </>
            ) : (
              "Create share link"
            )}
          </Button>
        </div>

        {lastCreated !== undefined ? (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm font-medium">
              Link ready
              {lastCreated.label.length > 0
                ? ` — ${lastCreated.label}`
                : ""}
              . Copy it now; the secret is not shown again.
            </p>
            <code className="block break-all rounded-md border bg-background px-2 py-1.5 font-mono text-xs">
              {lastCreated.url}
            </code>
            <div>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void handleCopy(lastCreated.url);
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        ) : null}

        {loading && shares.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BusyIcon />
            Loading shares…
          </div>
        ) : null}

        {active.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">
            No active share links.
          </p>
        ) : null}

        {active.length > 0 ? (
          <div className="flex w-full flex-col gap-2">
            {active.map((share) => (
              <Item key={share.shareId} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>
                    {share.label.length > 0 ? share.label : "Untitled link"}
                  </ItemTitle>
                  <ItemDescription>
                    Expires {formatExpiry(share.expiresAt)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={revokingId === share.shareId}
                    onClick={() => {
                      void handleRevoke(share);
                    }}
                  >
                    {revokingId === share.shareId ? "…" : "Revoke"}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
