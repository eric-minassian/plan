import type {
  CreateShareGrant,
  ShareGrant,
  ShareSession,
} from "@tripplan/domain";
import {
  MAX_ACTIVE_SHARES_PER_TRIP,
  SHARE_DEFAULT_EXPIRY_DAYS,
  SHARE_MAX_EXPIRY_DAYS,
  SHARE_SESSION_TTL_SECONDS,
  normalizeInstant,
} from "@tripplan/domain";
import { Context, Effect } from "effect";
import { AppError } from "../errors/app-error.js";
import {
  generateSessionId,
  generateShareId,
  generateShareToken,
  hashShareToken,
} from "./share-token.js";

export { MAX_ACTIVE_SHARES_PER_TRIP };

export interface CreateShareGrantResult {
  readonly grant: ShareGrant;
  /** Raw token — return once to the owner; never persist. */
  readonly rawToken: string;
}

export interface ShareRepository {
  /**
   * Create a share grant for an active owned trip.
   * Caller must verify trip ownership first (or pass through owner path).
   */
  readonly createGrant: (
    ownerId: string,
    tripId: string,
    input: CreateShareGrant,
    now?: Date,
  ) => Effect.Effect<CreateShareGrantResult, AppError>;

  /** List grants for a trip (any revoked state). */
  readonly listGrants: (
    tripId: string,
  ) => Effect.Effect<readonly ShareGrant[], AppError>;

  /** Get grant by primary key. */
  readonly getGrant: (
    tripId: string,
    shareId: string,
  ) => Effect.Effect<ShareGrant | undefined, AppError>;

  /**
   * Look up grant by token hash (GSI2). Returns undefined when unknown.
   * Does not interpret revoked/expired — caller revalidates.
   */
  readonly findGrantByTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<ShareGrant | undefined, AppError>;

  /**
   * Set revoked=true and delete all sessions for the share (GSI4 only).
   * 404 if grant missing or not owned by ownerId.
   */
  readonly revokeGrant: (
    ownerId: string,
    tripId: string,
    shareId: string,
  ) => Effect.Effect<ShareGrant, AppError>;

  readonly createSession: (
    tripId: string,
    shareId: string,
    now?: Date,
  ) => Effect.Effect<ShareSession, AppError>;

  readonly getSession: (
    sessionId: string,
  ) => Effect.Effect<ShareSession | undefined, AppError>;

  readonly deleteSession: (
    sessionId: string,
  ) => Effect.Effect<void, AppError>;
}

export class ShareRepo extends Context.Tag("ShareRepo")<
  ShareRepo,
  ShareRepository
>() {}

function nowInstant(now: Date = new Date()): string {
  return normalizeInstant(now.toISOString());
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function addSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * Resolve and validate grant `expiresAt`.
 * Default now+30d; must be strictly in the future; max now+365d.
 */
export function resolveGrantExpiresAt(
  inputExpiresAt: string | undefined,
  now: Date = new Date(),
): Effect.Effect<string, AppError> {
  return Effect.try({
    try: () => {
      const max = addDays(now, SHARE_MAX_EXPIRY_DAYS);
      let expires: Date;
      if (inputExpiresAt === undefined) {
        expires = addDays(now, SHARE_DEFAULT_EXPIRY_DAYS);
      } else {
        expires = new Date(inputExpiresAt);
        if (Number.isNaN(expires.getTime())) {
          throw AppError.validation("expiresAt must be a valid Instant");
        }
      }
      if (expires.getTime() <= now.getTime()) {
        throw AppError.validation("expiresAt must be strictly in the future");
      }
      if (expires.getTime() > max.getTime()) {
        throw AppError.validation(
          `expiresAt must be at most ${String(SHARE_MAX_EXPIRY_DAYS)} days from now`,
        );
      }
      return normalizeInstant(expires.toISOString());
    },
    catch: (e) => (e instanceof AppError ? e : AppError.internal()),
  });
}

export function isGrantUsable(
  grant: ShareGrant,
  now: Date = new Date(),
): boolean {
  if (grant.revoked) {
    return false;
  }
  const exp = new Date(grant.expiresAt).getTime();
  return exp > now.getTime();
}

export function isSessionUsable(
  session: ShareSession,
  now: Date = new Date(),
): boolean {
  return new Date(session.exp).getTime() > now.getTime();
}

/**
 * In-memory share grant + session store for unit tests and interim runtime.
 */
export function makeInMemoryShareRepo(
  seedGrants: Iterable<ShareGrant> = [],
  seedSessions: Iterable<ShareSession> = [],
): ShareRepository {
  /** tripId → shareId → grant */
  const grants = new Map<string, Map<string, ShareGrant>>();
  /** tokenHash → { tripId, shareId } */
  const byTokenHash = new Map<string, { tripId: string; shareId: string }>();
  /** sessionId → session */
  const sessions = new Map<string, ShareSession>();
  /** shareId → sessionIds */
  const sessionsByShare = new Map<string, Set<string>>();

  const putGrant = (grant: ShareGrant): void => {
    let bucket = grants.get(grant.tripId);
    if (bucket === undefined) {
      bucket = new Map();
      grants.set(grant.tripId, bucket);
    }
    bucket.set(grant.shareId, grant);
    byTokenHash.set(grant.tokenHash, {
      tripId: grant.tripId,
      shareId: grant.shareId,
    });
  };

  for (const grant of seedGrants) {
    putGrant(grant);
  }
  for (const session of seedSessions) {
    sessions.set(session.sessionId, session);
    let set = sessionsByShare.get(session.shareId);
    if (set === undefined) {
      set = new Set();
      sessionsByShare.set(session.shareId, set);
    }
    set.add(session.sessionId);
  }

  return {
    createGrant: (ownerId, tripId, input, now = new Date()) =>
      Effect.gen(function* () {
        const expiresAt = yield* resolveGrantExpiresAt(input.expiresAt, now);
        const existing = grants.get(tripId);
        let activeCount = 0;
        if (existing !== undefined) {
          for (const g of existing.values()) {
            if (!g.revoked) {
              activeCount += 1;
            }
          }
        }
        if (activeCount >= MAX_ACTIVE_SHARES_PER_TRIP) {
          return yield* Effect.fail(
            AppError.validation(
              `Active share limit reached (max ${String(MAX_ACTIVE_SHARES_PER_TRIP)} per trip)`,
              { maxActiveShares: MAX_ACTIVE_SHARES_PER_TRIP },
            ),
          );
        }
        const rawToken = generateShareToken();
        const tokenHash = hashShareToken(rawToken);
        const grant: ShareGrant = {
          shareId: generateShareId(),
          tripId,
          ownerId,
          tokenHash,
          expiresAt,
          revoked: false,
          label: input.label ?? "",
        };
        putGrant(grant);
        return { grant, rawToken };
      }),

    listGrants: (tripId) =>
      Effect.sync(() => {
        const bucket = grants.get(tripId);
        if (bucket === undefined) {
          return [];
        }
        return [...bucket.values()].sort((a, b) =>
          a.shareId < b.shareId ? -1 : a.shareId > b.shareId ? 1 : 0,
        );
      }),

    getGrant: (tripId, shareId) =>
      Effect.sync(() => grants.get(tripId)?.get(shareId)),

    findGrantByTokenHash: (tokenHash) =>
      Effect.sync(() => {
        const ref = byTokenHash.get(tokenHash);
        if (ref === undefined) {
          return undefined;
        }
        return grants.get(ref.tripId)?.get(ref.shareId);
      }),

    revokeGrant: (ownerId, tripId, shareId) =>
      Effect.try({
        try: () => {
          const grant = grants.get(tripId)?.get(shareId);
          if (grant === undefined || grant.ownerId !== ownerId) {
            throw AppError.notFound("Share not found");
          }
          const revoked: ShareGrant = { ...grant, revoked: true };
          putGrant(revoked);
          // GSI4-equivalent: delete sessions for this share only.
          const set = sessionsByShare.get(shareId);
          if (set !== undefined) {
            for (const sessionId of set) {
              sessions.delete(sessionId);
            }
            sessionsByShare.delete(shareId);
          }
          return revoked;
        },
        catch: (e) => (e instanceof AppError ? e : AppError.internal()),
      }),

    createSession: (tripId, shareId, now = new Date()) =>
      Effect.sync(() => {
        const session: ShareSession = {
          sessionId: generateSessionId(),
          tripId,
          shareId,
          exp: nowInstant(addSeconds(now, SHARE_SESSION_TTL_SECONDS)),
        };
        sessions.set(session.sessionId, session);
        let set = sessionsByShare.get(shareId);
        if (set === undefined) {
          set = new Set();
          sessionsByShare.set(shareId, set);
        }
        set.add(session.sessionId);
        return session;
      }),

    getSession: (sessionId) => Effect.sync(() => sessions.get(sessionId)),

    deleteSession: (sessionId) =>
      Effect.sync(() => {
        const existing = sessions.get(sessionId);
        if (existing === undefined) {
          return;
        }
        sessions.delete(sessionId);
        const set = sessionsByShare.get(existing.shareId);
        if (set !== undefined) {
          set.delete(sessionId);
          if (set.size === 0) {
            sessionsByShare.delete(existing.shareId);
          }
        }
      }),
  };
}
