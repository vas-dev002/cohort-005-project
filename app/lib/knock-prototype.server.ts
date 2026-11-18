// PROTOTYPE — throwaway Knock spike for "Does Knock hold up against Cadence?"
// (vas-dev002/cohort-005-project#35). Lives on the prototype/knock-spike
// branch only. Never merge.
import Knock, { signUserToken } from "@knocklabs/node";

// React Router's dev server doesn't put .env into process.env.
try {
  process.loadEnvFile(".env");
} catch {
  // already loaded, or no .env — the checks below will say so
}

export const KNOCK_WORKFLOWS = {
  discussionReply: "discussion-reply",
  newEnrollment: "new-enrollment",
} as const;

let client: Knock | undefined;
function knock() {
  client ??= new Knock({ apiKey: process.env.KNOCK_SECRET_API_KEY });
  return client;
}

export function knockPublicConfig() {
  return {
    publicKey: process.env.KNOCK_PUBLIC_API_KEY ?? "",
    feedChannelId: process.env.KNOCK_FEED_CHANNEL_ID ?? "",
  };
}

export async function signKnockUserToken(userId: number) {
  // Reads KNOCK_SIGNING_KEY (base64 PEM), RS256.
  return signUserToken(String(userId), { expiresInSeconds: 3600 });
}

export async function identifyKnockUser(user: {
  id: number;
  name: string;
  email: string;
}) {
  return knock().users.update(String(user.id), {
    name: user.name,
    email: user.email,
  });
}

type Recipient = { id: number; name: string; email: string };
// Inline-identify: Knock silently drops a trigger for a user id it has never
// seen, so always send the recipient's profile with the trigger.
const inline = (r: Recipient) => ({ id: String(r.id), name: r.name, email: r.email });

export async function triggerDiscussionReply(args: {
  questionAuthor: Recipient;
  replierId: number;
  replierName: string;
  lessonId: number;
  questionId: number;
  replyId: number;
  replyExcerpt: string;
  url: string;
}) {
  return knock().workflows.trigger(KNOCK_WORKFLOWS.discussionReply, {
    recipients: [inline(args.questionAuthor)],
    actor: String(args.replierId),
    data: {
      replier_name: args.replierName,
      lesson_id: args.lessonId,
      question_id: args.questionId,
      reply_id: args.replyId,
      reply_excerpt: args.replyExcerpt,
      url: args.url,
    },
  });
}

export async function triggerNewEnrollment(args: {
  instructor: Recipient;
  studentName: string;
  courseTitle: string;
}) {
  return knock().workflows.trigger(KNOCK_WORKFLOWS.newEnrollment, {
    recipients: [inline(args.instructor)],
    data: {
      student_name: args.studentName,
      course_title: args.courseTitle,
    },
  });
}
