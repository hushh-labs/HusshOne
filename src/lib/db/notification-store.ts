import { getPrismaClient } from "./prisma";

export interface CreatePendingOneNotificationInput {
  userId: string | null;
  scanRunId: string | null;
  notificationType: string;
  recipientEmail: string;
  subject: string;
}

export interface CreatePendingOneNotificationResult {
  id: string | null;
  skipped: boolean;
  error?: string | null;
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}

export async function createPendingOneNotification(
  input: CreatePendingOneNotificationInput,
): Promise<CreatePendingOneNotificationResult> {
  const prisma = getPrismaClient();
  if (!prisma || !input.scanRunId) {
    return { id: null, skipped: false };
  }

  try {
    const row = await prisma.oneNotification.create({
      data: {
        userId: input.userId,
        scanRunId: input.scanRunId,
        notificationType: input.notificationType,
        recipientEmail: input.recipientEmail,
        subject: input.subject,
        status: "pending",
      },
      select: { id: true },
    });
    return { id: row.id, skipped: false };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { id: null, skipped: true, error: "duplicate_notification" };
    }
    console.warn(
      JSON.stringify({
        event: "one.notification.create_failed",
        recipientEmail: input.recipientEmail,
        notificationType: input.notificationType,
        error: error instanceof Error ? error.message : "Unknown notification log error",
      }),
    );
    return {
      id: null,
      skipped: false,
      error: error instanceof Error ? error.message : "Unknown notification log error",
    };
  }
}

export async function markOneNotificationSent(id: string | null, messageId?: string | null) {
  const prisma = getPrismaClient();
  if (!prisma || !id) return;
  await prisma.oneNotification
    .update({
      where: { id },
      data: {
        status: "sent",
        providerMessageId: messageId ?? null,
        errorMessage: null,
        sentAt: new Date(),
      },
    })
    .catch((error) => {
      console.warn(
        JSON.stringify({
          event: "one.notification.mark_sent_failed",
          id,
          error: error instanceof Error ? error.message : "Unknown notification update error",
        }),
      );
    });
}

export async function markOneNotificationFailed(id: string | null, errorMessage: string) {
  const prisma = getPrismaClient();
  if (!prisma || !id) return;
  await prisma.oneNotification
    .update({
      where: { id },
      data: {
        status: "failed",
        errorMessage,
      },
    })
    .catch((error) => {
      console.warn(
        JSON.stringify({
          event: "one.notification.mark_failed_failed",
          id,
          error: error instanceof Error ? error.message : "Unknown notification update error",
        }),
      );
    });
}
