import { create } from "@bufbuild/protobuf";
import { attachmentServiceClient, instanceServiceClient } from "@/connect";
import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import { AttachmentSchema, MotionMediaSchema } from "@/types/proto/api/v1/attachment_service_pb";
import type { LocalFile } from "../types/attachment";
import { preprocessImageForUpload, type UploadConfig } from "./imageProcessing";

const getUploadConfig = async (): Promise<UploadConfig | null> => {
  try {
    return (await instanceServiceClient.getInstanceUploadConfig()) as UploadConfig;
  } catch {
    return null;
  }
};

export const uploadService = {
  async uploadFiles(localFiles: LocalFile[]): Promise<Attachment[]> {
    if (localFiles.length === 0) return [];

    const attachments: Attachment[] = [];
    const uploadConfig = await getUploadConfig();

    for (const localFile of localFiles) {
      const { file: originalFile, motionMedia } = localFile;
      // Live Photo pairs keep their original media to preserve the still/video grouping.
      const file = motionMedia ? originalFile : await preprocessImageForUpload(originalFile, uploadConfig?.imageProcessing);
      const buffer = new Uint8Array(await file.arrayBuffer());
      const attachment = await attachmentServiceClient.createAttachment({
        attachment: create(AttachmentSchema, {
          filename: file.name,
          size: BigInt(file.size),
          type: file.type,
          content: buffer,
          motionMedia: motionMedia ? create(MotionMediaSchema, motionMedia) : undefined,
        }),
      });
      attachments.push(attachment);
    }

    return attachments;
  },
};
