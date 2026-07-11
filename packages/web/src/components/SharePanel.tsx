import type {
  CreateShareResponse,
  ShareGrantPublic,
} from "@tripplan/domain";
import { useCallback, useEffect, useState } from "react";
import type { TripPlanApi } from "../api/client.ts";
import { formatApiError } from "../api/errors.ts";

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
      setError("Could not copy to clipboard — select the link and copy manually.");
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
    <section className="panel share-panel">
      <div className="panel__header">
        <h2>Share</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            void loadShares();
          }}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      <p className="muted share-panel__hint">
        Anyone with the link can view the{" "}
        <strong>full itinerary</strong> (titles, times, notes, confirmation
        codes, locations) until the link expires or you revoke it. No account
        required.{" "}
        <strong>
          Opening another shared trip in this browser switches the active share
          view
        </strong>{" "}
        (one share session cookie at a time).
      </p>

      {error !== undefined ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="share-panel__create">
        <label className="field">
          <span className="field__label">Label (optional)</span>
          <input
            className="field__input"
            type="text"
            maxLength={80}
            value={label}
            placeholder="Family, Friends…"
            onChange={(e) => {
              setLabel(e.target.value);
            }}
            disabled={creating}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={creating}
          onClick={() => {
            void handleCreate();
          }}
        >
          {creating ? "Creating…" : "Create share link"}
        </button>
      </div>

      {lastCreated !== undefined ? (
        <div className="share-panel__created">
          <p className="share-panel__created-title">
            Link ready
            {lastCreated.label.length > 0
              ? ` — ${lastCreated.label}`
              : ""}
            . Copy it now; the secret is not shown again.
          </p>
          <code className="share-panel__url">{lastCreated.url}</code>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              void handleCopy(lastCreated.url);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}

      {loading && shares.length === 0 ? (
        <p className="muted">Loading shares…</p>
      ) : null}

      {active.length === 0 && !loading ? (
        <p className="muted">No active share links.</p>
      ) : null}

      {active.length > 0 ? (
        <ul className="share-list">
          {active.map((share) => (
            <li key={share.shareId} className="share-list__item">
              <div>
                <div className="share-list__label">
                  {share.label.length > 0 ? share.label : "Untitled link"}
                </div>
                <div className="muted share-list__meta">
                  Expires {formatExpiry(share.expiresAt)}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={revokingId === share.shareId}
                onClick={() => {
                  void handleRevoke(share);
                }}
              >
                {revokingId === share.shareId ? "…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
