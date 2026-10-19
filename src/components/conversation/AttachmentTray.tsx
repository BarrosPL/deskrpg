"use client";
import { useT } from "@/lib/i18n";
import type { ConversationRef, FileView } from "@/lib/conversation-attachments/types";
export default function AttachmentTray({
  files,
  selectedIds = [],
  sharedScope,
  onSelect,
  onRetry,
  onRemove,
  onCancel,
  onExclude,
  downloadUrl,
}: {
  files: FileView[];
  selectedIds?: string[];
  sharedScope: ConversationRef["kind"];
  onSelect?: (id: string) => void;
  onRetry?: (id: string) => void;
  onRemove?: (id: string) => void;
  onCancel?: (id: string) => void;
  onExclude?: (id: string) => void;
  downloadUrl?: (id: string) => string;
}) {
  const t = useT();
  return (
    <div className="px-3 py-2 text-xs space-y-2" data-attachment-tray>
      <p className="text-text-muted">{t(`attachments.scope.${sharedScope}`)}</p>
      {files.map((file) => (
        <div
          key={file.id}
          className="flex flex-wrap items-center gap-2 text-text-secondary"
          data-attachment-state={file.state}
        >
          {onSelect && file.state !== "deleted" && (
            <input
              type="checkbox"
              aria-label={file.name}
              checked={selectedIds.includes(file.id)}
              disabled={file.state === "uploading" || file.state === "excluded"}
              onChange={() => onSelect(file.id)}
            />
          )}
          <span className="truncate max-w-48">{file.name}</span>
          <span>{t(`attachments.${file.state}`)}</span>
          {downloadUrl && !["deleted", "uploading", "failed"].includes(file.state) && (
            <a href={downloadUrl(file.id)} download>
              {t("attachments.download")}
            </a>
          )}
          {file.state === "failed" && onRetry && (
            <button type="button" onClick={() => onRetry(file.id)}>
              {t("attachments.retry")}
            </button>
          )}
          {file.state === "uploading" && onCancel && (
            <button type="button" onClick={() => onCancel(file.id)}>
              {t("attachments.cancel")}
            </button>
          )}
          {onExclude && !["deleted", "excluded", "uploading"].includes(file.state) && (
            <button type="button" onClick={() => onExclude(file.id)}>
              {t("attachments.exclude")}
            </button>
          )}
          {file.state !== "deleted" && file.state !== "uploading" && onRemove && (
            <button type="button" onClick={() => onRemove(file.id)}>
              {t("attachments.remove")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
