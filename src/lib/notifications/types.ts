export type ScanEmailRecipientStatus = "sent" | "failed" | "skipped";
export type ScanEmailAudienceStatus = "sent" | "failed" | "partial" | "skipped";

export interface ScanEmailRecipientDelivery {
  recipient: string;
  status: ScanEmailRecipientStatus;
  messageId?: string | null;
  error?: string | null;
  notificationId?: string | null;
}

export interface ScanEmailAudienceDelivery {
  status: ScanEmailAudienceStatus;
  recipients: ScanEmailRecipientDelivery[];
  error?: string | null;
}

export interface ScanEmailDeliverySummary {
  user: ScanEmailAudienceDelivery;
  admins: ScanEmailAudienceDelivery;
}
