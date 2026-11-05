import { isEqual } from "lodash-es";
import { ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/contexts/InstanceContext";
import { InstanceSetting, InstanceSetting_Key } from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater, { buildInstanceSettingName } from "./useInstanceSettingUpdater";

type StorageType = "R2" | "S3" | "WEBDAV";
type ImageOutputFormat = "origin" | "webp" | "jpeg" | "png";

const DEFAULT_FILEPATH_TEMPLATE = "{username}/{date}/{shortId}.{ext}";

interface ImageProcessingSetting {
  enabled: boolean;
  compress: boolean;
  quality: number;
  maxEdge: number;
  format: ImageOutputFormat;
}

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  usePathStyle: boolean;
}

interface WebDAVConfig {
  baseUrl: string;
  username: string;
  password: string;
  rootPath: string;
}

interface RawStorageSetting {
  storageType?: unknown;
  filepathTemplate?: string;
  uploadSizeLimitMb?: number | bigint;
  s3Config?: Partial<S3Config>;
  webdavConfig?: Partial<WebDAVConfig>;
  imageProcessing?: Partial<ImageProcessingSetting>;
}

interface EditableStorageSetting {
  storageType: StorageType;
  filepathTemplate: string;
  uploadSizeLimitMb: number;
  imageProcessing: ImageProcessingSetting;
  s3: S3Config;
  webdav: WebDAVConfig;
}

const DEFAULT_UPLOAD_SIZE_LIMIT_MB = 100;
const MAX_UPLOAD_SIZE_LIMIT_MB = 100;

const normalizeUploadSizeLimit = (value: unknown): number => {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_UPLOAD_SIZE_LIMIT_MB;
  }
  return Math.min(Math.round(limit), MAX_UPLOAD_SIZE_LIMIT_MB);
};

const normalizeStorageType = (value: unknown): StorageType => {
  if (typeof value === "number") {
    return value === 3 ? "S3" : "R2";
  }
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return normalized === "S3" || normalized === "WEBDAV" ? normalized : "R2";
};

const normalizeImageFormat = (value: unknown): ImageOutputFormat => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "origin" || normalized === "webp" || normalized === "jpeg" || normalized === "png" ? normalized : "webp";
};

const normalizeImageProcessing = (raw: Partial<ImageProcessingSetting> | undefined): ImageProcessingSetting => ({
  enabled: raw?.enabled === true,
  compress: raw?.compress !== false,
  quality: Number.isFinite(Number(raw?.quality)) ? Number(raw?.quality) : 0.82,
  maxEdge: Number.isFinite(Number(raw?.maxEdge)) ? Number(raw?.maxEdge) : 2560,
  format: normalizeImageFormat(raw?.format),
});

const deriveStorageSetting = (raw: RawStorageSetting): EditableStorageSetting => ({
  storageType: normalizeStorageType(raw.storageType),
  filepathTemplate: raw.filepathTemplate ?? "",
  uploadSizeLimitMb: normalizeUploadSizeLimit(raw.uploadSizeLimitMb),
  imageProcessing: normalizeImageProcessing(raw.imageProcessing),
  s3: {
    endpoint: raw.s3Config?.endpoint ?? "",
    region: raw.s3Config?.region ?? "",
    bucket: raw.s3Config?.bucket ?? "",
    accessKeyId: raw.s3Config?.accessKeyId ?? "",
    accessKeySecret: "",
    usePathStyle: raw.s3Config?.usePathStyle ?? true,
  },
  webdav: {
    baseUrl: raw.webdavConfig?.baseUrl ?? "",
    username: raw.webdavConfig?.username ?? "",
    password: "",
    rootPath: raw.webdavConfig?.rootPath ?? "",
  },
});

const StorageSection = () => {
  const t = useTranslate();
  const saveInstanceSetting = useInstanceSettingUpdater();
  const { storageSetting } = useInstance();
  const rawSetting = storageSetting as unknown as RawStorageSetting;
  const original = useMemo(() => deriveStorageSetting(rawSetting), [rawSetting]);
  const [config, setConfig] = useState<EditableStorageSetting>(original);

  useEffect(() => {
    setConfig(original);
  }, [original]);

  const hasExistingS3Secret = Boolean(rawSetting.s3Config?.accessKeySecret);
  const hasExistingWebDAVPassword = Boolean(rawSetting.webdavConfig?.password);
  const hasChanges = !isEqual(config, original);

  const backendLabel =
    config.storageType === "S3"
      ? t("setting.storage.type-s3")
      : config.storageType === "WEBDAV"
        ? t("setting.storage.type-webdav")
        : t("setting.storage.current-backend-r2");

  const saveStorageSetting = async () => {
    if (config.storageType === "S3") {
      const hasSecret = Boolean(config.s3.accessKeySecret.trim() || hasExistingS3Secret);
      if (!config.s3.endpoint.trim() || !config.s3.bucket.trim() || !config.s3.accessKeyId.trim() || !hasSecret) {
        toast.error(t("setting.storage.storage-config-incomplete"));
        return;
      }
    }
    if (config.storageType === "WEBDAV" && !config.webdav.baseUrl.trim()) {
      toast.error(t("setting.storage.storage-config-incomplete"));
      return;
    }

    const s3Config: S3Config = {
      ...config.s3,
      accessKeySecret: config.s3.accessKeySecret || rawSetting.s3Config?.accessKeySecret || "",
    };
    const webdavConfig: WebDAVConfig = {
      ...config.webdav,
      password: config.webdav.password || rawSetting.webdavConfig?.password || "",
    };

    await saveInstanceSetting({
      key: InstanceSetting_Key.STORAGE,
      setting: {
        name: buildInstanceSettingName(InstanceSetting_Key.STORAGE),
        value: {
          case: "storageSetting",
          value: {
            storageType: config.storageType,
            uploadSizeLimitMb: normalizeUploadSizeLimit(config.uploadSizeLimitMb),
            filepathTemplate: config.filepathTemplate.trim(),
            imageProcessing: {
              enabled: config.imageProcessing.enabled,
              compress: config.imageProcessing.compress,
              quality: Math.min(1, Math.max(0.1, config.imageProcessing.quality)),
              maxEdge: Math.max(0, Math.round(config.imageProcessing.maxEdge)),
              format: config.imageProcessing.format,
            },
            s3Config,
            webdavConfig,
          },
        },
      } as unknown as InstanceSetting,
      errorContext: "Update storage settings",
    });
  };

  return (
    <SettingSection title={t("setting.storage.label")}>
      <SettingGroup title={t("setting.storage.current-storage")} description={t("setting.storage.current-storage-description")}>
        <SettingPanel className="rounded-md border border-border bg-muted/20 px-3 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ServerIcon className="size-4" />
              <span>{backendLabel}</span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t("setting.storage.current-backend-description")}</p>
          </div>
        </SettingPanel>
      </SettingGroup>

      <SettingGroup title={t("setting.storage.storage-type")} description={t("setting.storage.storage-type-description")}>
        <SettingRow label={t("setting.storage.storage-type")}>
          <Select
            value={config.storageType}
            onValueChange={(value) => setConfig((prev) => ({ ...prev, storageType: value as StorageType }))}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="R2">{t("setting.storage.current-backend-r2")}</SelectItem>
              <SelectItem value="S3">{t("setting.storage.type-s3")}</SelectItem>
              <SelectItem value="WEBDAV">{t("setting.storage.type-webdav")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("setting.storage.upload-path")} description={t("setting.storage.upload-path-description")}>
        <SettingRow label={t("setting.storage.upload-path-template")} description={t("setting.storage.upload-path-template-description")}>
          <Input
            className="w-full font-mono sm:w-80"
            value={config.filepathTemplate}
            placeholder={DEFAULT_FILEPATH_TEMPLATE}
            onChange={(event) => setConfig((prev) => ({ ...prev, filepathTemplate: event.target.value }))}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("setting.storage.upload-size-limit")} description={t("setting.storage.upload-size-limit-description")}>
        <SettingRow label={t("setting.storage.upload-size-limit")} description={t("setting.storage.upload-size-limit-hint")}>
          <div className="flex items-center gap-2">
            <Input
              className="w-full sm:w-32"
              type="number"
              min={1}
              max={MAX_UPLOAD_SIZE_LIMIT_MB}
              step={1}
              value={config.uploadSizeLimitMb}
              onChange={(event) => {
                const value = Number(event.target.value);
                setConfig((prev) => ({
                  ...prev,
                  uploadSizeLimitMb: Number.isFinite(value) ? value : prev.uploadSizeLimitMb,
                }));
              }}
            />
            <span className="text-sm text-muted-foreground">MiB</span>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("setting.storage.image-preprocessing")} description={t("setting.storage.image-preprocessing-description")}>
        <SettingRow
          label={t("setting.storage.image-preprocessing-enabled")}
          description={t("setting.storage.image-preprocessing-enabled-description")}
        >
          <Switch
            checked={config.imageProcessing.enabled}
            onCheckedChange={(checked) =>
              setConfig((prev) => ({ ...prev, imageProcessing: { ...prev.imageProcessing, enabled: checked } }))
            }
          />
        </SettingRow>
        {config.imageProcessing.enabled && (
          <>
            <SettingRow label={t("setting.storage.compress-images")} description={t("setting.storage.compress-images-description")}>
              <Switch
                checked={config.imageProcessing.compress}
                onCheckedChange={(checked) =>
                  setConfig((prev) => ({ ...prev, imageProcessing: { ...prev.imageProcessing, compress: checked } }))
                }
              />
            </SettingRow>
            <SettingRow label={t("setting.storage.output-format")} description={t("setting.storage.output-format-description")}>
              <Select
                value={config.imageProcessing.format}
                onValueChange={(value) =>
                  setConfig((prev) => ({
                    ...prev,
                    imageProcessing: { ...prev.imageProcessing, format: value as ImageOutputFormat },
                  }))
                }
              >
                <SelectTrigger className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="origin">{t("setting.storage.output-format-origin")}</SelectItem>
                  <SelectItem value="webp">{t("setting.storage.output-format-webp")}</SelectItem>
                  <SelectItem value="jpeg">{t("setting.storage.output-format-jpeg")}</SelectItem>
                  <SelectItem value="png">{t("setting.storage.output-format-png")}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label={t("setting.storage.compress-quality")} description={t("setting.storage.compress-quality-description")}>
              <Input
                className="w-full sm:w-32"
                type="number"
                min={0.1}
                max={1}
                step={0.05}
                value={config.imageProcessing.quality}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setConfig((prev) => ({
                    ...prev,
                    imageProcessing: { ...prev.imageProcessing, quality: Number.isFinite(value) ? value : prev.imageProcessing.quality },
                  }));
                }}
              />
            </SettingRow>
            <SettingRow label={t("setting.storage.max-edge")} description={t("setting.storage.max-edge-description")}>
              <Input
                className="w-full sm:w-32"
                type="number"
                min={0}
                step={1}
                value={config.imageProcessing.maxEdge}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setConfig((prev) => ({
                    ...prev,
                    imageProcessing: { ...prev.imageProcessing, maxEdge: Number.isFinite(value) ? value : prev.imageProcessing.maxEdge },
                  }));
                }}
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      {config.storageType === "S3" && (
        <SettingGroup title={t("setting.storage.s3-configuration")} description={t("setting.storage.s3-configuration-description")}>
          <SettingRow label={t("setting.storage.endpoint")} description={t("setting.storage.endpoint-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              value={config.s3.endpoint}
              placeholder="https://s3.example.com"
              onChange={(event) => setConfig((prev) => ({ ...prev, s3: { ...prev.s3, endpoint: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.region")} description={t("setting.storage.region-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              value={config.s3.region}
              placeholder="auto"
              onChange={(event) => setConfig((prev) => ({ ...prev, s3: { ...prev.s3, region: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.bucket")} description={t("setting.storage.bucket-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              value={config.s3.bucket}
              placeholder={t("setting.storage.bucket-placeholder")}
              onChange={(event) => setConfig((prev) => ({ ...prev, s3: { ...prev.s3, bucket: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.accesskey")} description={t("setting.storage.accesskey-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              value={config.s3.accessKeyId}
              placeholder={t("setting.storage.accesskey-placeholder")}
              onChange={(event) => setConfig((prev) => ({ ...prev, s3: { ...prev.s3, accessKeyId: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.secretkey")} description={t("setting.storage.secretkey-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              type="password"
              autoComplete="new-password"
              value={config.s3.accessKeySecret}
              placeholder={
                hasExistingS3Secret ? t("setting.storage.secretkey-preserve-description") : t("setting.storage.secretkey-placeholder")
              }
              onChange={(event) => setConfig((prev) => ({ ...prev, s3: { ...prev.s3, accessKeySecret: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.use-path-style")} description={t("setting.storage.use-path-style-description")}>
            <Switch
              checked={config.s3.usePathStyle}
              onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, s3: { ...prev.s3, usePathStyle: checked } }))}
            />
          </SettingRow>
        </SettingGroup>
      )}

      {config.storageType === "WEBDAV" && (
        <SettingGroup title={t("setting.storage.webdav-configuration")} description={t("setting.storage.webdav-configuration-description")}>
          <SettingRow label={t("setting.storage.webdav-url")} description={t("setting.storage.webdav-url-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              value={config.webdav.baseUrl}
              placeholder="https://dav.example.com/remote.php/dav/files/user"
              onChange={(event) => setConfig((prev) => ({ ...prev, webdav: { ...prev.webdav, baseUrl: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.webdav-root-path")} description={t("setting.storage.webdav-root-path-description")}>
            <Input
              className="w-full font-mono sm:w-80"
              value={config.webdav.rootPath}
              placeholder="memos"
              onChange={(event) => setConfig((prev) => ({ ...prev, webdav: { ...prev.webdav, rootPath: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.webdav-username")}>
            <Input
              className="w-full sm:w-80"
              value={config.webdav.username}
              onChange={(event) => setConfig((prev) => ({ ...prev, webdav: { ...prev.webdav, username: event.target.value } }))}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.webdav-password")} description={t("setting.storage.webdav-password-description")}>
            <Input
              className="w-full sm:w-80"
              type="password"
              autoComplete="new-password"
              value={config.webdav.password}
              placeholder={hasExistingWebDAVPassword ? t("setting.storage.secretkey-preserve-description") : ""}
              onChange={(event) => setConfig((prev) => ({ ...prev, webdav: { ...prev.webdav, password: event.target.value } }))}
            />
          </SettingRow>
        </SettingGroup>
      )}

      <div className="flex w-full justify-end">
        <Button disabled={!hasChanges} onClick={saveStorageSetting}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default StorageSection;
