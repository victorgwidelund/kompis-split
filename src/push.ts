import webpush from "web-push";
import { db } from "./database.js";

export const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || null;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || null;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

// Push stays fully inert (every call below no-ops) until both VAPID keys are actually configured --
// self-hosters who never set them up get no crash, just no push notifications.
const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushConfigured) webpush.setVapidDetails(vapidSubject, vapidPublicKey as string, vapidPrivateKey as string);

export interface PushMessage { title: string; body: string; url: string }

export async function sendPushToUser(userId: number, message: PushMessage): Promise<void> {
  if (!pushConfigured || !userId) return;
  const account = await db.prepare("SELECT notifications_enabled FROM users WHERE id = ?").get<any>(userId);
  if (!account?.notifications_enabled) return;
  const subscriptions = await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").all<any>(userId);
  if (!subscriptions.length) return;
  const payload = JSON.stringify(message);
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload);
    } catch (error) {
      // 404/410 means the browser/OS discarded this subscription -- clean it up. Any other error
      // (offline push service, malformed payload, etc.) is left alone; this is best-effort delivery,
      // never something the caller's actual action should fail over.
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(subscription.id);
    }
  }));
}
