// PROTOTYPE — throwaway Knock spike for "Does Knock hold up against Cadence?"
// (vas-dev002/cohort-005-project#35). Runs the four vendor-fit checks against
// the real app and whichever user the DevUI switcher selects. Never merge.
import { useEffect, useState } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import Knock, { type Feed, type FeedItem } from "@knocklabs/client";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Route } from "./+types/prototype.knock";
import { db } from "~/db";
import { comments, lessons, modules, courses, users } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import {
  identifyKnockUser,
  knockPublicConfig,
  signKnockUserToken,
  triggerDiscussionReply,
  triggerNewEnrollment,
} from "~/lib/knock-prototype.server";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) return { user: null } as const;

  const user = db.select().from(users).where(eq(users.id, userId)).get()!;

  let token: string | null = null;
  let serverError: string | null = null;
  try {
    token = await signKnockUserToken(user.id);
    await identifyKnockUser(user);
  } catch (e) {
    serverError = String(e);
  }

  // Questions someone else asked, so the current user can reply to them.
  const author = alias(users, "author");
  const questions = db
    .select({
      id: comments.id,
      lessonId: comments.lessonId,
      body: comments.body,
      authorId: author.id,
      authorName: author.name,
      lessonTitle: lessons.title,
    })
    .from(comments)
    .innerJoin(author, eq(author.id, comments.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .where(
      and(
        isNull(comments.parentId),
        isNull(comments.deletedAt),
        ne(comments.userId, user.id)
      )
    )
    .orderBy(desc(comments.createdAt))
    .limit(8)
    .all();

  return {
    user: { id: user.id, name: user.name, role: user.role },
    token,
    serverError,
    questions,
    ...knockPublicConfig(),
  } as const;
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) return { ok: false, result: "No user selected" };
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "reply") {
      const questionId = Number(form.get("questionId"));
      const question = db
        .select()
        .from(comments)
        .where(eq(comments.id, questionId))
        .get()!;
      const body = String(form.get("body") || "Prototype reply from the Knock spike");
      // A real Discussion Reply row, same shape createComment writes.
      const reply = db
        .insert(comments)
        .values({
          userId: me.id,
          lessonId: question.lessonId,
          parentId: question.id,
          body,
        })
        .returning()
        .get();
      const lesson = db
        .select({ slug: courses.slug })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(courses, eq(courses.id, modules.courseId))
        .where(eq(lessons.id, question.lessonId))
        .get();
      const result = await triggerDiscussionReply({
        questionAuthorId: question.userId,
        replierId: me.id,
        replierName: me.name,
        lessonId: question.lessonId,
        questionId: question.id,
        replyId: reply.id,
        replyExcerpt: body.slice(0, 140),
        url: `/courses/${lesson?.slug}/lessons/${question.lessonId}`,
      });
      return {
        ok: true,
        result: { recipient: question.userId, replyId: reply.id, ...result },
      };
    }

    if (intent === "enrollment") {
      const result = await triggerNewEnrollment({
        instructorId: me.id,
        studentName: "Prototype Student",
        courseTitle: "Prototype Course",
      });
      return { ok: true, result: { recipient: me.id, ...result } };
    }
  } catch (e) {
    return { ok: false, result: String(e) };
  }
  return { ok: false, result: `Unknown intent ${String(intent)}` };
}

export default function KnockPrototype({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();

  if (!loaderData.user) {
    return (
      <div className="p-8">
        Select a user in the DevUI panel to run the Knock spike.
      </div>
    );
  }
  const { user, token, serverError, questions, publicKey, feedChannelId } =
    loaderData;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 text-sm">
      <div className="rounded border-2 border-dashed border-amber-500 bg-amber-50 p-3 dark:bg-amber-950">
        <strong>PROTOTYPE</strong> — Knock spike for “Does Knock hold up
        against Cadence?”. Throwaway; branch <code>prototype/knock-spike</code>.
      </div>

      <section className="space-y-1">
        <h2 className="text-lg font-semibold">1. Signed user token</h2>
        <p>
          Viewing as <strong>{user.name}</strong> (id {user.id}, {user.role}).
          Switch users in the DevUI panel: the feed below must switch with
          you.
        </p>
        {serverError ? (
          <pre className="text-red-600">{serverError}</pre>
        ) : (
          <TokenView token={token!} />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">2. Trigger a Discussion Reply</h2>
        <p>
          Reply (as {user.name}) to someone else’s Discussion Question. The
          question author should get it in their feed: switch to them to see
          it.
        </p>
        <ul className="space-y-1">
          {questions.map((q) => (
            <li key={q.id} className="flex items-center gap-2">
              <Form method="post">
                <input type="hidden" name="intent" value="reply" />
                <input type="hidden" name="questionId" value={q.id} />
                <button
                  className="rounded bg-blue-600 px-2 py-1 text-white disabled:opacity-50"
                  disabled={nav.state !== "idle"}
                >
                  Reply
                </button>
              </Form>
              <span>
                <strong>{q.authorName}</strong> (id {q.authorId}) on “
                {q.lessonTitle}”: {q.body.slice(0, 80)}
              </span>
            </li>
          ))}
          {questions.length === 0 && <li>No questions from other users.</li>}
        </ul>
        <Form method="post">
          <input type="hidden" name="intent" value="enrollment" />
          <button className="rounded bg-purple-600 px-2 py-1 text-white">
            Trigger new Enrollment → me (preference check)
          </button>
        </Form>
        {actionData && (
          <pre
            className={
              "overflow-auto rounded p-2 " +
              (actionData.ok ? "bg-green-50 dark:bg-green-950" : "bg-red-50 dark:bg-red-950")
            }
          >
            {JSON.stringify(actionData.result, null, 2)}
          </pre>
        )}
      </section>

      {token && (
        <KnockPanel
          key={user.id}
          userId={String(user.id)}
          token={token}
          publicKey={publicKey}
          feedChannelId={feedChannelId}
        />
      )}
    </div>
  );
}

function TokenView({ token }: { token: string }) {
  const [header, payload] = token.split(".").slice(0, 2).map((p) => {
    try {
      return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return p;
    }
  });
  return (
    <pre className="overflow-auto rounded bg-muted p-2">
      {JSON.stringify({ header, payload }, null, 2)}
    </pre>
  );
}

type Log = { at: string; msg: string };

function KnockPanel(props: {
  userId: string;
  token: string;
  publicKey: string;
  feedChannelId: string;
}) {
  const [knock, setKnock] = useState<Knock | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [meta, setMeta] = useState<unknown>(null);
  const [prefs, setPrefs] = useState<unknown>(null);
  const [log, setLog] = useState<Log[]>([]);
  const add = (msg: string) =>
    setLog((l) => [{ at: new Date().toLocaleTimeString(), msg }, ...l].slice(0, 30));

  useEffect(() => {
    const k = new Knock(props.publicKey);
    k.authenticate(props.userId, props.token);
    const f = k.feeds.initialize(props.feedChannelId);
    const unsub = f.store.subscribe((s) => {
      setItems(s.items);
      setMeta(s.metadata);
    });
    f.fetch()
      .then((r) => add(`feed.fetch → ${r ? "ok" : "no response"}`))
      .catch((e) => add(`feed.fetch FAILED: ${e}`));
    f.listenForUpdates();
    setKnock(k);
    setFeed(f);
    loadPrefs(k);
    return () => {
      unsub();
      f.dispose();
      k.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userId, props.token]);

  async function loadPrefs(k = knock) {
    if (!k) return;
    try {
      setPrefs(await k.user.getPreferences());
      add("getPreferences → ok");
    } catch (e) {
      add(`getPreferences FAILED: ${e}`);
    }
  }

  async function setEnrollmentOptIn(on: boolean) {
    if (!knock) return;
    try {
      const current = await knock.user.getPreferences();
      const next = await knock.user.setPreferences({
        workflows: current.workflows ?? undefined,
        channel_types: current.channel_types ?? undefined,
        channels: current.channels ?? undefined,
        categories: { ...(current.categories ?? {}), "new-enrollment": on },
      });
      setPrefs(next);
      add(`setPreferences new-enrollment=${on} → ok`);
    } catch (e) {
      add(`setPreferences FAILED: ${e}`);
    }
  }

  async function forgedFetch() {
    // Same user id, no signed token: must be rejected once enhanced
    // security mode is on.
    const res = await fetch(
      `https://api.knock.app/v1/users/${props.userId}/feeds/${props.feedChannelId}`,
      { headers: { Authorization: `Bearer ${props.publicKey}` } }
    );
    add(`unsigned feed request → HTTP ${res.status}`);
    // Someone else's id with my token: must also be rejected.
    const other = String(Number(props.userId) + 1);
    const res2 = await fetch(
      `https://api.knock.app/v1/users/${other}/feeds/${props.feedChannelId}`,
      {
        headers: {
          Authorization: `Bearer ${props.publicKey}`,
          "X-Knock-User-Token": props.token,
        },
      }
    );
    add(`my token, user ${other}'s feed → HTTP ${res2.status}`);
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      add(`${label} → ok`);
    } catch (e) {
      add(`${label} FAILED: ${e}`);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">3. Headless feed API</h2>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => run("feed.fetch", () => feed!.fetch())}>Refetch</Btn>
          <Btn onClick={() => run("markAllAsSeen", () => feed!.markAllAsSeen())}>
            Mark all seen
          </Btn>
          <Btn onClick={() => run("markAllAsRead", () => feed!.markAllAsRead())}>
            Mark all read
          </Btn>
          <Btn onClick={forgedFetch}>Try unsigned / wrong-user requests</Btn>
        </div>
        <pre className="rounded bg-muted p-2">{JSON.stringify(meta, null, 2)}</pre>
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.id} className="rounded border p-2">
              <div className="flex justify-between gap-2">
                <span>
                  <strong>{it.source.key}</strong>{" "}
                  {String((it.data as Record<string, unknown>)?.replier_name ?? (it.data as Record<string, unknown>)?.student_name ?? "")}
                  {" — "}
                  {String((it.data as Record<string, unknown>)?.reply_excerpt ?? (it.data as Record<string, unknown>)?.course_title ?? "")}
                </span>
                <span className="text-xs">
                  {it.seen_at ? "seen" : "UNSEEN"} / {it.read_at ? "read" : "UNREAD"}
                </span>
              </div>
              <div className="mt-1 flex gap-2">
                <Btn onClick={() => run(`markAsSeen ${it.id}`, () => feed!.markAsSeen(it))}>seen</Btn>
                <Btn onClick={() => run(`markAsRead ${it.id}`, () => feed!.markAsRead(it))}>read</Btn>
                <Btn onClick={() => run(`markAsUnread ${it.id}`, () => feed!.markAsUnread(it))}>unread</Btn>
              </div>
            </li>
          ))}
          {items.length === 0 && <li>Feed is empty.</li>}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">4. Preferences</h2>
        <p>
          new-enrollment should be <strong>off</strong> unless this user
          opted in (environment default set in the Knock dashboard).
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => setEnrollmentOptIn(true)}>Opt in to new-enrollment</Btn>
          <Btn onClick={() => setEnrollmentOptIn(false)}>Opt out</Btn>
          <Btn onClick={() => loadPrefs()}>Reload</Btn>
        </div>
        <pre className="overflow-auto rounded bg-muted p-2">{JSON.stringify(prefs, null, 2)}</pre>
        <h3 className="font-semibold">Log</h3>
        <ul className="font-mono text-xs">
          {log.map((l, i) => (
            <li key={i}>
              {l.at} {l.msg}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Btn(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="rounded border px-2 py-1 hover:bg-muted"
    >
      {props.children}
    </button>
  );
}
