export type ImageOutputFormat = "origin" | "webp" | "jpeg" | "png";

export interface ImageProcessingConfig {
  enabled: boolean;
  compress: boolean;
  quality: number;
  maxEdge: number;
  format: ImageOutputFormat;
}

export interface UploadConfig {
  filepathTemplate: string;
  uploadSizeLimitMb: number;
  imageProcessing: ImageProcessingConfig;
}

const COMPRESSIBLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

const FORMAT_MIME_TYPES: Record<Exclude<ImageOutputFormat, "origin">, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

const DEFAULT_QUALITY = 0.82;

interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

const loadImage = async (file: File): Promise<DecodedImage> => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to the HTMLImageElement based decoder.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image cannot be decoded."));
    });
    image.src = url;
    await loaded;
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
};

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });

const replaceExtension = (filename: string, mimeType: string): string => {
  const extension = EXTENSION_BY_MIME[mimeType] ?? ".webp";
  const baseName = filename.trim().replace(/\.[^.]+$/, "") || "image";
  return `${baseName}${extension}`;
};

export const preprocessImageForUpload = async (file: File, config?: ImageProcessingConfig): Promise<File> => {
  if (!config?.enabled || !COMPRESSIBLE_IMAGE_TYPES.has(file.type)) {
    return file;
  }

  const targetType = config.format === "origin" ? file.type : FORMAT_MIME_TYPES[config.format] ?? file.type;
  const formatChanged = targetType !== file.type;
  if (!config.compress && !formatChanged) {
    return file;
  }

  try {
    const source = await loadImage(file);
    const maxEdge = Number.isFinite(config.maxEdge) ? Math.max(0, Math.round(config.maxEdge)) : 0;
    const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(source.width, source.height)) : 1;
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      source.close?.();
      return file;
    }

    // JPEG has no alpha channel; fill the canvas with white to avoid black backgrounds.
    if (targetType === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }

    context.drawImage(source.image, 0, 0, width, height);
    source.close?.();

    const quality = Number.isFinite(config.quality) ? Math.min(1, Math.max(0.1, config.quality)) : DEFAULT_QUALITY;
    const blob = await canvasToBlob(canvas, targetType, quality);
    canvas.width = canvas.height = 0;

    if (!blob) {
      return file;
    }

    // Keep the original when compression alone did not save any bytes.
    if (!formatChanged && blob.size >= file.size) {
      return file;
    }

    const outputType = blob.type || targetType;
    const filename = outputType === file.type ? file.name : replaceExtension(file.name, outputType);
    return new File([blob], filename, { type: outputType, lastModified: file.lastModified });
  } catch {
    return file;
  }
};
