import { isValidEmail, normalizeEmail } from "@/lib/auth/identity";
import {
  createPendingOneNotification,
  markOneNotificationFailed,
  markOneNotificationSent,
} from "@/lib/db/notification-store";
import type { OneDashboardResult, PersonAuditStatus } from "@/lib/ria/types";
import { FULL_SCAN_ADMIN_RECIPIENTS } from "./allowlist";
import { sendGmailEmail } from "./gmail";
import { buildScanResultEmailHtml } from "./scan-email-template";
import type {
  ScanEmailAudienceDelivery,
  ScanEmailDeliverySummary,
  ScanEmailRecipientDelivery,
} from "./types";

const USER_NOTIFICATION_TYPE = "scan_user_full_result";
const ADMIN_NOTIFICATION_TYPE = "scan_admin_full_result";

function subjectName(result: OneDashboardResult) {
  return result.subject.name || result.subject.email || "Hussh One user";
}

function audienceStatus(recipients: ScanEmailRecipientDelivery[]): ScanEmailAudienceDelivery["status"] {
  if (!recipients.length) return "skipped";
  if (recipients.every((recipient) => recipient.status === "sent")) return "sent";
  if (recipients.every((recipient) => recipient.status === "skipped")) return "skipped";
  if (recipients.every((recipient) => recipient.status === "failed")) return "failed";
  return "partial";
}

async function sendLoggedEmail(params: {
  userId: string | null;
  scanRunId: string | null;
  notificationType: string;
  recipientEmail: string;
  subject: string;
  html: string;
  fromName: string;
}): Promise<ScanEmailRecipientDelivery> {
  const recipientEmail = normalizeEmail(params.recipientEmail);
  const pending = await createPendingOneNotification({
    userId: params.userId,
    scanRunId: params.scanRunId,
    notificationType: params.notificationType,
    recipientEmail,
    subject: params.subject,
  });

  if (pending.skipped) {
    return {
      recipient: recipientEmail,
      status: "skipped",
      error: pending.error || "duplicate_notification",
      notificationId: pending.id,
    };
  }

  const sent = await sendGmailEmail({
    recipients: [recipientEmail],
    subject: params.subject,
    htmlContent: params.html,
    fromName: params.fromName,
  });

  if (sent.success) {
    await markOneNotificationSent(pending.id, sent.messageId);
    return {
      recipient: recipientEmail,
      status: "sent",
      messageId: sent.messageId ?? null,
      notificationId: pending.id,
    };
  }

  const error = sent.error || "Email send failed";
  await markOneNotificationFailed(pending.id, error);
  return {
    recipient: recipientEmail,
    status: "failed",
    error,
    notificationId: pending.id,
  };
}

async function sendAudience(params: {
  userId: string | null;
  scanRunId: string | null;
  notificationType: string;
  recipients: string[];
  subject: string;
  html: string;
  fromName: string;
}): Promise<ScanEmailAudienceDelivery> {
  const normalizedRecipients = Array.from(
    new Set(params.recipients.map((recipient) => normalizeEmail(recipient)).filter(isValidEmail)),
  );

  if (!normalizedRecipients.length) {
    return { status: "skipped", recipients: [], error: "no_valid_recipients" };
  }

  const recipients = await Promise.all(
    normalizedRecipients.map((recipientEmail) =>
      sendLoggedEmail({
        ...params,
        recipientEmail,
      }),
    ),
  );

  const status = audienceStatus(recipients);
  return {
    status,
    recipients,
    error: status === "sent" ? null : recipients.find((recipient) => recipient.error)?.error ?? null,
  };
}

export async function sendScanResultEmails(params: {
  userId: string | null;
  scanRunId: string | null;
  result: OneDashboardResult;
  audit: PersonAuditStatus | null;
  completedAt?: Date;
}): Promise<ScanEmailDeliverySummary> {
  const completedAt = params.completedAt ?? new Date();
  const userHtml = buildScanResultEmailHtml({
    result: params.result,
    audit: params.audit,
    audience: "user",
    completedAt,
  });
  const adminHtml = buildScanResultEmailHtml({
    result: params.result,
    audit: params.audit,
    audience: "admin",
    completedAt,
  });

  const [user, admins] = await Promise.all([
    sendAudience({
      userId: params.userId,
      scanRunId: params.scanRunId,
      notificationType: USER_NOTIFICATION_TYPE,
      recipients: [params.result.subject.email],
      subject: "Your Hussh One scan results",
      html: userHtml,
      fromName: "Hussh One",
    }),
    sendAudience({
      userId: params.userId,
      scanRunId: params.scanRunId,
      notificationType: ADMIN_NOTIFICATION_TYPE,
      recipients: FULL_SCAN_ADMIN_RECIPIENTS,
      subject: `[Hussh One] Scan completed: ${subjectName(params.result)}`,
      html: adminHtml,
      fromName: "Hussh One",
    }),
  ]);

  return { user, admins };
}
